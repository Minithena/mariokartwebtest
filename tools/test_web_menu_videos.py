import hashlib
from pathlib import Path
import struct
import tempfile
import unittest

from web_menu_videos import HEADER, halve_video, parse_video, prepare


def video(count=4, fps=60.0, audio=False):
    images = [bytes([65 + i]) * (20 + i * 47) for i in range(count)]
    sizes = [(12 + len(image) + 31) // 32 * 32 for image in images]
    data = bytearray(80)
    HEADER.pack_into(data, 0, b'THP\0', 0x11000, max(sizes), 0, fps, count,
                     sizes[0], sum(sizes), 48, 0, 80, 80 + sum(sizes[:-1]))
    struct.pack_into('>I16BIII', data, 48, 1, 1 if audio else 0, *([255] * 15), 512, 512, 0)
    for i, image in enumerate(images):
        frame = bytearray(sizes[i])
        struct.pack_into('>III', frame, 0, sizes[(i + 1) % count], sizes[i - 1], len(image))
        frame[12:12 + len(image)] = image
        data.extend(frame)
    return bytes(data)


class MenuVideoTests(unittest.TestCase):
    def test_kept_frames_are_identical_and_duration_is_unchanged(self):
        original = video()
        old, old_frames, _ = parse_video(original)
        result = halve_video(original)
        new, new_frames, _ = parse_video(result)
        self.assertEqual(new[4], 30.0)
        self.assertEqual(new[5], 2)
        self.assertEqual(old[5] / old[4], new[5] / new[4])
        for (start, size), (old_start, old_size) in zip(new_frames, old_frames[::2]):
            self.assertEqual(size, old_size)
            self.assertEqual(result[start + 8:start + size], original[old_start + 8:old_start + old_size])
        self.assertEqual(struct.unpack_from('>I', result, new_frames[0][0] + 4)[0], new_frames[-1][1])
        self.assertEqual(struct.unpack_from('>I', result, new_frames[-1][0])[0], new_frames[0][1])
        self.assertEqual(new[7], sum(size for _, size in new_frames))
        self.assertLess(len(result), len(original))

    def test_audio_odd_frames_and_already_slow_clips_are_rejected(self):
        for data in [video(audio=True), video(count=3), video(fps=30)]:
            with self.assertRaises(ValueError):
                halve_video(data)

    def test_truncated_or_invalid_linked_frames_are_rejected(self):
        with self.assertRaises(ValueError):
            halve_video(video()[:-1])
        data = bytearray(video())
        struct.pack_into('>I', data, 80, 1)
        with self.assertRaises(ValueError):
            halve_video(data)

    def test_staging_preserves_originals_and_can_restore_original_previews(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            source, output, cache = base / 'source', base / 'out', base / 'cache'
            clip = source / 'files/thp/button/single_top.thp'
            clip.parent.mkdir(parents=True)
            clip.write_bytes(video())
            original_hash = hashlib.sha256(clip.read_bytes()).digest()
            (source / 'sys').mkdir()
            (source / 'sys/fst.bin').write_bytes(b'fixture')
            self.assertEqual(prepare(source, output, cache)[0], 1)
            staged = output / clip.relative_to(source)
            self.assertEqual(HEADER.unpack_from(staged.read_bytes())[4], 30)
            timestamp = staged.stat().st_mtime_ns
            prepare(source, output, cache)
            self.assertEqual(staged.stat().st_mtime_ns, timestamp)
            self.assertEqual(hashlib.sha256(clip.read_bytes()).digest(), original_hash)
            self.assertEqual(prepare(source, output, cache, original=True)[0], 0)
            self.assertEqual(staged.resolve(), clip.resolve())
            self.assertEqual((output / 'sys/fst.bin').read_bytes(), b'fixture')


if __name__ == '__main__':
    unittest.main()
