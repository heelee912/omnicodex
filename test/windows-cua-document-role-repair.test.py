import hashlib
import importlib.util
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/windows/desktop-engine/repair-cua-document-role.py"
spec = importlib.util.spec_from_file_location("cua_repair", SCRIPT)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def fixture(text_rva=0x1000, data_rva=0x4000, predicate=0x240):
    image = bytearray(0xa00)
    image[:2] = b"MZ"
    struct.pack_into("<I", image, 0x3c, 0x80)
    image[0x80:0x84] = b"PE\0\0"
    struct.pack_into("<HH", image, 0x84, 0x8664, 2)
    struct.pack_into("<H", image, 0x94, 0xf0)
    struct.pack_into("<H", image, 0x98, 0x20b)
    table = 0x188
    struct.pack_into("<8sIIII", image, table, b".text", 0x400, text_rva, 0x400, 0x200)
    struct.pack_into("<I", image, table + 36, 0x60000020)
    struct.pack_into("<8sIIII", image, table + 40, b".rdata", 0x400, data_rva, 0x400, 0x600)
    struct.pack_into("<I", image, table + 76, 0x40000040)
    literal = 0x680
    image[literal:literal + len(repair.LITERAL_CONTEXT)] = repair.LITERAL_CONTEXT
    target_rva = data_rva + literal - 0x600 + repair.LITERAL_OFFSET
    lea_rva = text_rva + predicate - 0x200 + 16
    original = repair.ORIGINAL[:19] + struct.pack("<i", target_rva - lea_rva - 7) + repair.ORIGINAL[23:]
    image[predicate:predicate + 42] = original
    image[predicate - len(repair.PREFIX):predicate] = repair.PREFIX
    image[predicate + 42:predicate + 42 + len(repair.SUFFIX)] = repair.SUFFIX
    return bytes(image)


class RepairTests(unittest.TestCase):
    def test_relocation_and_round_trip(self):
        for trva, drva in [(0x1000, 0x4000), (0x8000, 0x3000), (0x20000, 0x90000)]:
            with self.subTest(trva=trva, drva=drva):
                original = fixture(trva, drva)
                self.assertEqual(repair.inspect_image(original)[:2], ("original", 0x240))
                patched, offset = repair.prepare(original, "apply")
                self.assertEqual(offset, 0x240)
                self.assertEqual(repair.inspect_image(patched)[0], "repaired")
                self.assertEqual(repair.prepare(patched, "apply")[0], patched)
                self.assertEqual(repair.prepare(patched, "restore")[0], original)
                self.assertEqual(repair.prepare(original, "restore")[0], original)
                self.assertEqual(sum(a != b for a, b in zip(original, patched)), 36)

    def test_not_a_hash_gate(self):
        image = bytearray(fixture())
        image[0x9f0] = 123
        self.assertEqual(repair.prepare(repair.prepare(bytes(image), "apply")[0], "restore")[0], bytes(image))

    def test_unknown_and_ambiguous_fail_closed(self):
        original = fixture()
        cases = []
        bad = bytearray(original); bad[0x240 + 30] ^= 1; cases.append(bad)
        bad = bytearray(original); bad[0x680] ^= 1; cases.append(bad)
        bad = bytearray(original); bad[0x700:0x700 + len(repair.LITERAL_CONTEXT)] = repair.LITERAL_CONTEXT; cases.append(bad)
        bad = bytearray(original); bad[0x300:0x32a] = bad[0x240:0x26a]
        # Relocate the second LEA to the same literal.
        struct.pack_into("<i", bad, 0x300 + 19, struct.unpack_from("<i", bad, 0x240 + 19)[0] - 0xc0)
        cases.append(bad)
        patched = repair.prepare(original, "apply")[0]
        bad = bytearray(patched); bad[0x300:0x32a] = repair.REPAIRED; cases.append(bad)
        bad = bytearray(original); bad[0x300:0x32a] = repair.REPAIRED; cases.append(bad)
        bad = bytearray(original); bad[0x240 - 1] ^= 1; cases.append(bad)
        bad = bytearray(original); bad[0x240 + 42] ^= 1; cases.append(bad)
        bad = bytearray(original); bad[0x84:0x86] = b"\x4c\x01"; cases.append(bad)
        bad = bytearray(original); struct.pack_into("<I", bad, 0x188 + 40 + 12, 0x1000); cases.append(bad)
        cases.append(original[:0x190])
        for image in cases:
            with self.subTest(case=cases.index(image)):
                for action in ("apply", "restore"):
                    with self.assertRaises(ValueError):
                        repair.prepare(bytes(image), action)

    def test_write_and_verified_rollback(self):
        original = fixture()
        with tempfile.TemporaryFile(mode="w+b") as f:
            f.write(original); f.flush()
            expected, changed = repair.change_stream(f, "apply")
            self.assertTrue(changed)
            self.assertEqual(repair.change_stream(f, "restore"), (original, True))
            self.assertEqual(repair.change_stream(f, "restore"), (original, False))
            real_verify = repair._sync_and_verify
            calls = []
            def fail_once(stream, image):
                calls.append(1)
                if len(calls) == 1:
                    raise OSError("simulated readback failure")
                return real_verify(stream, image)
            with mock.patch.object(repair, "_sync_and_verify", side_effect=fail_once):
                with self.assertRaisesRegex(OSError, "restored and verified"):
                    repair.change_stream(f, "apply")
            f.seek(0)
            self.assertEqual(f.read(), original)
            self.assertNotEqual(expected, original)

    def test_partial_write_rolls_back(self):
        class PartialWrite:
            def __init__(self, stream):
                self.stream = stream
                self.first = True

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def write(self, data):
                if self.first:
                    self.first = False
                    return self.stream.write(data[:10])
                return self.stream.write(data)

        original = fixture()
        with tempfile.TemporaryFile(mode="w+b") as stream:
            stream.write(original)
            with self.assertRaisesRegex(OSError, "restored and verified"):
                repair.change_stream(PartialWrite(stream), "apply")
            stream.seek(0)
            self.assertEqual(stream.read(), original)

    @unittest.skipUnless(os.name == "nt", "Windows exclusive handle test")
    def test_exclusive_handle_rejects_second_open(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.exe"
            path.write_bytes(fixture())
            with repair.exclusive_binary_file(path):
                with self.assertRaises(OSError):
                    with repair.exclusive_binary_file(path):
                        pass
            self.assertEqual(path.read_bytes(), fixture())

    def test_offline_0717_copy_if_present(self):
        scratch = os.environ.get("PI_SCRATCH_DIR")
        if not scratch:
            self.skipTest("PI_SCRATCH_DIR unavailable")
        path = Path(scratch) / "codex-cua-fork-inspect/patched-0.7.17/codex-computer-use.exe"
        if not path.is_file():
            self.skipTest("offline 0.7.17 copy unavailable")
        patched = path.read_bytes()
        self.assertEqual(hashlib.sha256(patched).hexdigest(), "0a8fe73a9f95cf2ac741ae5267ec9fe57f7ee26e010621acf0fbe2727e5dbd60")
        self.assertEqual(repair.inspect_image(patched)[:2], ("repaired", 0x1b655))
        original, _ = repair.prepare(patched, "restore")
        self.assertEqual(hashlib.sha256(original).hexdigest(),
                         "0ebb47bfaaf729e22bcdb08dcfce1419eefeda80afaefed3edbc088c24a2e778")
        self.assertEqual(repair.inspect_image(original)[0], "original")
        self.assertEqual(repair.prepare(original, "apply")[0], patched)
        self.assertEqual(sum(a != b for a, b in zip(original, patched)), 36)


if __name__ == "__main__":
    unittest.main()
