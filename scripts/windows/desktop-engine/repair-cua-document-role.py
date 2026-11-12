#!/usr/bin/env python3
"""Inspect or manually repair the known Windows CUA document-role predicate."""

import argparse
import ctypes
import hashlib
import json
import os
import struct
import sys
from contextlib import contextmanager
from pathlib import Path

ORIGINAL = bytes.fromhex(
    "488b8c2488020000488b9424900200004c8d0556bb110041b908000000"
    "e82452ffff84c00f84e7000000"
)
REPAIRED = bytes.fromhex(
    "4889e9488b01488d942480000000ff90a801000085c0780d81bc2480000000"
    "6ec300007405e9e7000000"
)
PREFIX = bytes.fromhex("488b742450")
SUFFIX = bytes.fromhex("488b942450030000")
# The original LEA targets this unique string-table span in both observed
# helpers. Restore must reconstruct the *same* RIP-relative address, not merely
# any nearby string starting with "document".
LITERAL_CONTEXT = b"documentelementtree item"
LITERAL_OFFSET = 0
LITERAL = b"document"


def _unpack(fmt, data, offset):
    size = struct.calcsize(fmt)
    if offset < 0 or offset + size > len(data):
        raise ValueError("Truncated PE structure")
    return struct.unpack_from(fmt, data, offset)


def sections(data):
    """Return validated, non-overlapping file-backed PE sections."""
    if len(data) < 64 or data[:2] != b"MZ":
        raise ValueError("Not a DOS/PE image")
    pe = _unpack("<I", data, 0x3c)[0]
    if pe < 64 or data[pe:pe + 4] != b"PE\0\0":
        raise ValueError("Invalid PE signature")
    machine, count = _unpack("<HH", data, pe + 4)
    opt_size = _unpack("<H", data, pe + 20)[0]
    opt = pe + 24
    if machine != 0x8664 or not 1 <= count <= 96 or opt_size < 112:
        raise ValueError("Expected a supported PE32+ x64 image")
    if _unpack("<H", data, opt)[0] != 0x20b:
        raise ValueError("Expected PE32+ optional header")
    table = opt + opt_size
    if table + count * 40 > len(data):
        raise ValueError("Truncated PE section table")
    result = []
    virtual_ranges = []
    for i in range(count):
        pos = table + 40 * i
        name, vsize, rva, raw_size, raw = _unpack("<8sIIII", data, pos)
        flags = _unpack("<I", data, pos + 36)[0]
        if raw_size and (raw < table + count * 40 or raw + raw_size > len(data)):
            raise ValueError("Invalid PE section bounds")
        if rva + max(vsize, raw_size) > 0x100000000:
            raise ValueError("Invalid section RVA")
        virtual_ranges.append((rva, max(vsize, raw_size)))
        result.append((name.rstrip(b"\0"), rva, raw, raw_size, flags))
    for i, a in enumerate(result):
        for j in range(i + 1, len(result)):
            b = result[j]
            av, bv = virtual_ranges[i], virtual_ranges[j]
            raw_overlap = a[3] and b[3] and max(a[2], b[2]) < min(a[2] + a[3], b[2] + b[3])
            virtual_overlap = av[1] and bv[1] and max(av[0], bv[0]) < min(av[0] + av[1], bv[0] + bv[1])
            if raw_overlap or virtual_overlap:
                raise ValueError("Overlapping PE sections")
    return result


def occurrences(data, needle, start, end):
    pos = start
    while True:
        pos = data.find(needle, pos, end)
        if pos < 0:
            return
        yield pos
        pos += 1


def inspect_image(data):
    """Classify only the exact known predicate and uniquely identified literal."""
    parts = sections(data)
    texts = [s for s in parts if s[0] == b".text" and s[3] and s[4] & 0x20000000]
    if len(texts) != 1 or sum(s[0] == b".text" for s in parts) != 1:
        raise ValueError("Expected exactly one executable .text section")
    text = texts[0]
    lo, hi = text[2], text[2] + text[3]
    literals = []
    for name, rva, raw, size, flags in parts:
        if name == b".rdata" and not flags & 0x20000000:
            for pos in occurrences(data, LITERAL_CONTEXT, raw, raw + size):
                literals.append((pos + LITERAL_OFFSET, rva + pos + LITERAL_OFFSET - raw))
    if len(literals) != 1:
        raise ValueError("Expected one uniquely contextualized document literal in .rdata")
    literal_pos, literal_rva = literals[0]
    # Count every LEA r8 to any file-backed occurrence of 'document', not just
    # matching templates. Ambiguity is rejected before choosing a predicate.
    refs = []
    for lea in occurrences(data, b"\x4c\x8d\x05", lo, hi):
        if lea + 7 > hi:
            continue
        disp = _unpack("<i", data, lea + 3)[0]
        target = text[1] + (lea - lo) + 7 + disp
        for _, rva, raw, size, _ in parts:
            if rva <= target and target + len(LITERAL) <= rva + size:
                file_pos = raw + target - rva
                if data[file_pos:file_pos + len(LITERAL)] == LITERAL:
                    refs.append((lea, file_pos))
    repaired = list(occurrences(data, REPAIRED, lo, hi))
    def check_context(start):
        if (start - len(PREFIX) < lo or start + len(ORIGINAL) + len(SUFFIX) > hi or
                data[start - len(PREFIX):start] != PREFIX or
                data[start + len(ORIGINAL):start + len(ORIGINAL) + len(SUFFIX)] != SUFFIX):
            raise ValueError("Unknown predicate surrounding instructions")

    if len(refs) == 1 and not repaired:
        lea, target = refs[0]
        start = lea - 16
        if target != literal_pos or start < lo or start + len(ORIGINAL) > hi:
            raise ValueError("Document LEA has unexpected location or literal")
        region = data[start:start + len(ORIGINAL)]
        if region[:19] != ORIGINAL[:19] or region[23:] != ORIGINAL[23:]:
            raise ValueError("Unknown document predicate template")
        check_context(start)
        return "original", start, literal_rva
    if not refs and len(repaired) == 1:
        check_context(repaired[0])
        return "repaired", repaired[0], literal_rva
    raise ValueError("Unknown or ambiguous document predicate; no write attempted")


def prepare(data, action):
    if action not in ("apply", "restore"):
        raise ValueError("Unknown action")
    state, start, literal_rva = inspect_image(data)
    desired = "repaired" if action == "apply" else "original"
    if state == desired:
        return data, start
    if action == "apply":
        replacement = REPAIRED
    else:
        text = next(s for s in sections(data) if s[0] == b".text")
        lea_rva = text[1] + start - text[2] + 16
        displacement = literal_rva - (lea_rva + 7)
        if not -(1 << 31) <= displacement < (1 << 31):
            raise ValueError("Document literal is outside RIP-relative range")
        replacement = ORIGINAL[:19] + struct.pack("<i", displacement) + ORIGINAL[23:]
    result = data[:start] + replacement + data[start + len(ORIGINAL):]
    if inspect_image(result)[0] != desired:
        raise ValueError("Derived image failed semantic readback")
    return result, start


@contextmanager
def exclusive_binary_file(path):
    if os.name != "nt":
        raise OSError("Apply and restore require Windows; inspect is portable")
    import msvcrt
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    handle = create(str(path), 0x80000000 | 0x40000000, 0, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        fd = msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR)
    except Exception:
        close(handle)
        raise
    try:
        stream = os.fdopen(fd, "r+b")
    except Exception:
        os.close(fd)
        raise
    with stream:
        yield stream


def _sync_and_verify(stream, expected):
    stream.flush()
    os.fsync(stream.fileno())
    stream.seek(0)
    if stream.read() != expected:
        raise OSError("Whole-file readback differs from expected image")


def change_stream(stream, action):
    stream.seek(0)
    before = stream.read()
    expected, start = prepare(before, action)
    if expected == before:
        return before, False
    try:
        stream.seek(start)
        if stream.write(expected[start:start + len(ORIGINAL)]) != len(ORIGINAL):
            raise OSError("Incomplete predicate write")
        _sync_and_verify(stream, expected)
    except Exception as error:
        try:
            stream.seek(0)
            if stream.write(before) != len(before):
                raise OSError("Incomplete rollback write")
            stream.truncate(len(before))
            _sync_and_verify(stream, before)
        except Exception as rollback_error:
            raise OSError(f"Write failed ({error}); rollback also failed ({rollback_error}). "
                          "Do not use this file; recover it from a trusted source.") from rollback_error
        raise OSError(f"Write failed ({error}); pre-operation image restored and verified") from error
    return expected, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("inspect", "apply", "restore"))
    parser.add_argument("helper", type=Path, help="Explicit path to a helper image")
    args = parser.parse_args()
    try:
        path = args.helper.resolve(strict=True)
        if args.action == "inspect":
            image, changed = path.read_bytes(), False
        else:
            with exclusive_binary_file(path) as stream:
                image, changed = change_stream(stream, args.action)
        state, offset, _ = inspect_image(image)
        print(json.dumps({"status": "SUCCESS", "action": args.action, "path": str(path),
                          "state": state, "changed": changed, "predicate_offset": hex(offset),
                          "sha256": hashlib.sha256(image).hexdigest()}))
        return 0
    except (OSError, ValueError) as error:
        print(json.dumps({"status": "ERROR", "action": args.action, "error": str(error)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
