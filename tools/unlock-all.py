#!/usr/bin/env python3
"""Unlock everything in a Mario Kart Wii (PAL RMCP01) rksys.dat save.

Usage:
    python3 tools/unlock-all.py INPUT [-o OUTPUT] [--force]
    python3 tools/unlock-all.py --self-test

Without -o the file is patched in place (INPUT.bak is written once first).

Format facts used (mkwiiki.org/wiki/Rksys.dat, formerly wiki.tockdom.com, and
the RKPD struct in MelgMKW/Pulsar GameSource/MarioKartWii/RKSYS/RKPD.hpp,
cross-checked against the layout in yomcube/file-utils src/filetypes/rksys.ts):
  * file = 0x2BC000 bytes, big-endian, magic "RKSD" + version "0006"
  * four RKPD licences of 0x8CC0 bytes at 0x8, 0x8CC8, 0x11988, 0x1A648
    (an unused slot does not start with "RKPD")
  * RKPD+0x14: Mii name, 10 x UTF-16BE
  * RKPD+0x30..0x37: a 64-bit big-endian bitfield of completion + unlock flags,
    fields packed MSB-first in declaration order (PowerPC bitfield order)
  * checksum: CRC-32 (standard zlib) of bytes 0x0..0x27FFB, stored big-endian
    at 0x27FFC. Ghost data (0x28000..) is not covered.
Only the documented unlock/completion bits are set; bits documented as unused
and the "ending screen seen" bits are left untouched.  Cup/star/trophy records
are not touched (the flags below are what the game reads for unlocks).
"""
import argparse
import os
import shutil
import struct
import sys
import zlib

FILE_SIZE = 0x2BC000
MAGIC = b"RKSD"
RKPD_MAGIC = b"RKPD"
RKPD_OFFSETS = (0x8, 0x8CC8, 0x11988, 0x1A648)
RKPD_SIZE = 0x8CC0
CRC_OFFSET = 0x27FFC
FLAGS_OFF = 0x30  # within RKPD, u64 big-endian
NAME_OFF = 0x14

# Fields in declaration order, MSB-first.  None = documented unused/reserved
# or non-unlock (left untouched).  Each entry is (name, group) or None.
_LAYOUT = (
    [("karts 100cc", "completion"), ("bikes 50cc", "completion")]
    + [(f"{c} cup {cc}", "completion")
       for c in ("leaf", "banana", "star", "flower")
       for cc in ("mirror", "150cc", "100cc", "50cc")]
    + [(n, "character") for n in (
        "mii outfit B", "mii outfit A", "rosalina", "funky kong", "king boo",
        "dry bowser", "birdo", "daisy", "bowser jr", "diddy kong",
        "baby luigi", "baby daisy", "toadette", "dry bones")]
    + [None] * 6                                     # reserved
    + [None, None]                                   # ending screens seen
    + [None] * 3                                     # reserved
    + [("mirror mode", "mode")]
    + [(n, "vehicle") for n in (
        "phantom", "spear", "shooting star", "dolphin dasher", "sneakster",
        "zip zip", "jet bubble", "magikruiser", "quacker", "honeycoupe",
        "jetsetter", "piranha prowler", "sprinter", "daytripper",
        "super blooper", "blue falcon", "tiny titan", "cheep charger")]
    + [None] * 2                                     # reserved
)
assert len(_LAYOUT) == 64

FIELDS = {}  # name -> (mask, group)
for _i, _f in enumerate(_LAYOUT):
    if _f:
        FIELDS[_f[0]] = (1 << (63 - _i), _f[1])
UNLOCK_MASK = 0
for _m, _g in FIELDS.values():
    UNLOCK_MASK |= _m
GROUPS = ("completion", "character", "mode", "vehicle")


def compute_crc(data):
    return zlib.crc32(data[:CRC_OFFSET]) & 0xFFFFFFFF


def stored_crc(data):
    return struct.unpack_from(">I", data, CRC_OFFSET)[0]


def validate(data):
    """Return list of fatal structural problems (empty if OK)."""
    errs = []
    if len(data) != FILE_SIZE:
        errs.append(f"size is {len(data)} bytes, expected {FILE_SIZE}")
    if data[:4] != MAGIC:
        errs.append(f"bad magic {data[:4]!r}, expected {MAGIC!r}")
    return errs


def licence_name(data, off):
    raw = data[off + NAME_OFF:off + NAME_OFF + 20]
    return raw.decode("utf-16-be", errors="replace").split("\x00")[0]


def patch(data):
    """Patch bytearray in place. Returns per-licence info list."""
    info = []
    for slot, off in enumerate(RKPD_OFFSETS):
        if bytes(data[off:off + 4]) != RKPD_MAGIC:
            info.append((slot, None, None))
            continue
        old = struct.unpack_from(">Q", data, off + FLAGS_OFF)[0]
        new = old | UNLOCK_MASK
        struct.pack_into(">Q", data, off + FLAGS_OFF, new)
        added = {g: sum(1 for m, gg in FIELDS.values()
                        if gg == g and (new & m) and not (old & m))
                 for g in GROUPS}
        info.append((slot, licence_name(data, off), added))
    struct.pack_into(">I", data, CRC_OFFSET, compute_crc(data))
    return info


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("input", nargs="?")
    ap.add_argument("-o", "--output")
    ap.add_argument("--force", action="store_true",
                    help="continue even if the existing checksum is wrong")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args(argv)
    if a.self_test:
        return self_test()
    if not a.input:
        ap.error("INPUT required")
    with open(a.input, "rb") as f:
        data = bytearray(f.read())
    errs = validate(data)
    if errs:
        print("error: " + "; ".join(errs), file=sys.stderr)
        return 1
    if stored_crc(data) != compute_crc(data):
        msg = (f"existing checksum {stored_crc(data):08x} != computed "
               f"{compute_crc(data):08x}")
        if not a.force:
            print(f"error: {msg} (use --force to patch anyway)", file=sys.stderr)
            return 1
        print(f"warning: {msg}; continuing due to --force", file=sys.stderr)
    info = patch(data)
    out = a.output or a.input
    if not a.output:
        bak = a.input + ".bak"
        if not os.path.exists(bak):
            shutil.copyfile(a.input, bak)
            print(f"backup written: {bak}")
    with open(out, "wb") as f:
        f.write(data)
    for slot, name, added in info:
        if name is None:
            print(f"licence {slot + 1}: empty, untouched")
        else:
            desc = ", ".join(f"{n} {g}" for g, n in added.items() if n) \
                or "nothing (already fully unlocked)"
            print(f"licence {slot + 1} ({name or 'no name'}): newly set: {desc}")
    print(f"checksum: {compute_crc(data):08x} written to 0x{CRC_OFFSET:X}")
    print(f"wrote {out}")
    return 0


def self_test():
    import importlib.util
    import tempfile
    import unittest

    me = sys.modules[__name__]

    def blank(slots=(0,)):
        d = bytearray(FILE_SIZE)
        d[:8] = b"RKSD0006"
        for s in slots:
            o = RKPD_OFFSETS[s]
            d[o:o + 4] = RKPD_MAGIC
            d[o + 0x14:o + 0x18] = "Ab".encode("utf-16-be")
            d[o + 0x34] = 0x03          # reserved bits / ending flags marker
        d[0x32000:0x32004] = b"RKGD"
        struct.pack_into(">I", d, CRC_OFFSET, compute_crc(d))
        return d

    import contextlib
    import io

    class T(unittest.TestCase):
        def setUp(self):
            st = contextlib.ExitStack()
            st.enter_context(contextlib.redirect_stdout(io.StringIO()))
            st.enter_context(contextlib.redirect_stderr(io.StringIO()))
            self.addCleanup(st.close)

        def test_mask_counts(self):
            self.assertEqual(len(FIELDS), 18 + 14 + 1 + 18)
            self.assertEqual(UNLOCK_MASK.bit_count()
                             if hasattr(int, "bit_count") else
                             bin(UNLOCK_MASK).count("1"), 51)

        def test_known_bits(self):
            # first byte: karts100cc is MSB of 0x30; mirror mode is 0x35 bit 0x10
            self.assertEqual(FIELDS["karts 100cc"][0], 1 << 63)
            self.assertEqual(FIELDS["rosalina"][0], 1 << (63 - 20))
            self.assertEqual(FIELDS["mirror mode"][0], 1 << (63 - 43))
            self.assertEqual(FIELDS["phantom"][0], 1 << (63 - 44))
            self.assertEqual(FIELDS["cheep charger"][0], 1 << (63 - 61))

        def test_patch_and_idempotent(self):
            d = blank((0, 2))
            ghost = bytes(d[0x28000:])
            orig = bytes(d)
            info = patch(d)
            self.assertEqual(stored_crc(d), compute_crc(d))
            self.assertEqual(info[1][1], None)       # empty slot
            self.assertEqual(info[0][1], "Ab")
            v = struct.unpack_from(">Q", d, RKPD_OFFSETS[0] + FLAGS_OFF)[0]
            self.assertEqual(v & UNLOCK_MASK, UNLOCK_MASK)
            o = struct.unpack_from(">Q", orig, RKPD_OFFSETS[0] + FLAGS_OFF)[0]
            self.assertEqual(v & ~UNLOCK_MASK, o & ~UNLOCK_MASK)  # reserved untouched
            self.assertNotEqual(v & ~UNLOCK_MASK, 0)
            self.assertEqual(bytes(d[RKPD_OFFSETS[1]:RKPD_OFFSETS[1] + RKPD_SIZE]),
                             orig[RKPD_OFFSETS[1]:RKPD_OFFSETS[1] + RKPD_SIZE])
            self.assertEqual(bytes(d[0x28000:]), ghost)
            again = bytearray(d)
            patch(again)
            self.assertEqual(again, d)

        def test_cli(self):
            with tempfile.TemporaryDirectory() as t:
                p = os.path.join(t, "rksys.dat")
                open(p, "wb").write(blank())
                self.assertEqual(main([p]), 0)
                self.assertTrue(os.path.exists(p + ".bak"))
                once = open(p, "rb").read()
                self.assertEqual(main([p]), 0)
                self.assertEqual(open(p, "rb").read(), once)
                # .bak is the pristine original, not overwritten
                self.assertEqual(open(p + ".bak", "rb").read(), bytes(blank()))
                o = os.path.join(t, "out.dat")
                self.assertEqual(main([p, "-o", o]), 0)
                self.assertEqual(open(o, "rb").read(), once)

        def test_bad_inputs(self):
            with tempfile.TemporaryDirectory() as t:
                p = os.path.join(t, "x")
                open(p, "wb").write(b"RKSD0006")
                self.assertEqual(main([p]), 1)           # wrong size
                d = blank()
                d[0] = 0
                open(p, "wb").write(d)
                self.assertEqual(main([p]), 1)           # bad magic
                d = blank()
                d[0x100] ^= 1                            # corrupt: bad crc
                open(p, "wb").write(d)
                self.assertEqual(main([p]), 1)
                self.assertEqual(main([p, "--force", "-o", p + ".o"]), 0)
                self.assertEqual(stored_crc(open(p + ".o", "rb").read()),
                                 compute_crc(open(p + ".o", "rb").read()))

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(T)
    r = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if r.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
