#!/usr/bin/env python3
"""Prepare browser menu previews with half as many video frames at the same playback speed.

Original extracted files are never changed. Kept JPEG frames are copied byte for byte: only the
video-only THP container's frame links, frame count, rate and offsets change. Other game files
are linked into a separate staging tree. All output is game-derived and must stay out of git.

Container reference: https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/thp.c
"""
import argparse
import json
import math
from pathlib import Path
import struct

HEADER = struct.Struct('>4sIIIfIIIIIII')
GENERATOR_VERSION = 1


def parse_video(data):
    if len(data) < HEADER.size:
        raise ValueError('Truncated THP header')
    h = list(HEADER.unpack_from(data))
    magic, version, _, _, fps, count, size, data_size, components, offsets, first, last = h
    if magic != b'THP\0' or version not in (0x10000, 0x11000):
        raise ValueError('Unsupported THP version')
    if not math.isfinite(fps) or fps <= 0 or count < 2:
        raise ValueError('Invalid THP frame rate/count')
    if offsets != 0:
        raise ValueError('Seek-table THP files require a separate conversion')
    if components < HEADER.size or components + 20 > first or first > len(data):
        raise ValueError('Invalid component offsets')
    if struct.unpack_from('>I', data, components)[0] != 1 or data[components + 4] != 0:
        raise ValueError('Only video-only menu previews may be converted')
    frames, position = [], first
    for index in range(count):
        if size < 12 or position + size > len(data):
            raise ValueError('Truncated THP frame')
        next_size, previous_size, image_size = struct.unpack_from('>III', data, position)
        if image_size > size - 12:
            raise ValueError('Frame image extends past its container')
        if index and previous_size != frames[-1][1]:
            raise ValueError('Invalid previous-frame link')
        frames.append((position, size))
        position += size
        size = next_size
    if frames[-1][0] != last or position != first + data_size:
        raise ValueError('Invalid final frame/data size')
    if size not in (0, frames[0][1]):
        raise ValueError('Invalid looping frame link')
    return h, frames, position


def halve_video(data):
    h, frames, end = parse_video(data)
    if h[5] % 2 or h[4] < 50:
        raise ValueError('Expected an even number of frames at 50 FPS or more')
    kept = frames[::2]
    out = bytearray(data[:h[10]])
    loop = struct.unpack_from('>I', data, frames[-1][0])[0] != 0
    first_has_previous = struct.unpack_from('>I', data, frames[0][0] + 4)[0] != 0
    last_offset = 0
    for index, (position, size) in enumerate(kept):
        last_offset = len(out)
        frame = bytearray(data[position:position + size])
        next_size = kept[index + 1][1] if index + 1 < len(kept) else kept[0][1] if loop else 0
        previous_size = kept[index - 1][1] if index else kept[-1][1] if first_has_previous else 0
        struct.pack_into('>II', frame, 0, next_size, previous_size)
        out.extend(frame)
    h[2] = max(size for _, size in kept)
    h[4] /= 2
    h[5] = len(kept)
    h[6] = kept[0][1]
    h[7] = len(out) - h[10]
    h[11] = last_offset
    HEADER.pack_into(out, 0, *h)
    out.extend(data[end:])
    # Validate every output link before it can become a served asset.
    parse_video(out)
    return bytes(out)


def is_menu_video(relative):
    parts = relative.parts
    return (len(parts) == 4 and parts[:2] == ('files', 'thp') and relative.suffix == '.thp'
            and (parts[2] in ('button', 'course', 'battle') or parts[2:] == ('title', 'top_menu.thp')))


def prepare(source, output, cache, original=False):
    source, output, cache = (p.resolve() for p in (source, output, cache))
    if output == source or output.is_relative_to(source) or cache == source or cache.is_relative_to(source):
        raise ValueError('Generated output must be outside the extracted disc directory')
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    state_path = cache / 'state.json'
    try:
        state = json.loads(state_path.read_text())
    except (FileNotFoundError, ValueError):
        state = {}
    total_in = total_out = converted = 0
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        destination = output / relative
        if path.is_dir():
            if destination.is_symlink():
                raise ValueError(f'Refusing to write through a directory symlink: {destination}')
            destination.mkdir(parents=True, exist_ok=True)
            continue
        if not path.is_file():
            continue
        target = path
        if not original and is_menu_video(relative):
            target = cache / relative
            stat = path.stat()
            fingerprint = [GENERATOR_VERSION, stat.st_size, stat.st_mtime_ns]
            key = relative.as_posix()
            entry = state.get(key, {})
            if entry.get('source') != fingerprint or not target.is_file() or target.stat().st_size != entry.get('size'):
                data = halve_video(path.read_bytes())
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_suffix('.tmp')
                temporary.write_bytes(data)
                temporary.replace(target)
                state[key] = {'source': fingerprint, 'size': len(data)}
            converted += 1
            total_in += stat.st_size
            total_out += target.stat().st_size
        if destination.is_symlink():
            if destination.readlink() == target:
                continue
            destination.unlink()
        elif destination.exists():
            raise ValueError(f'Refusing to replace a non-link in the staging tree: {destination}')
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(target)
    state_path.write_text(json.dumps(state, indent=2, sort_keys=True) + '\n')
    return converted, total_in, total_out


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('cache', type=Path)
    parser.add_argument('--original-videos', action='store_true')
    args = parser.parse_args()
    count, before, after = prepare(args.source, args.output, args.cache, args.original_videos)
    print(f'Browser menu previews: {count} clips at half frame rate, {before / 1e6:.1f} → {after / 1e6:.1f} MB.')
