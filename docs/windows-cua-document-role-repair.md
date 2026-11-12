# Manual Windows CUA document-role repair

This is an opt-in binary workaround, not an official fix, and it does not modify the native helper's source. On the observed Korean Windows setup, the helper compared a localized UI Automation role to the English string `document`. The replacement treats a successful `CachedControlType` read equal to `UIA_DocumentControlTypeId` (50030) as the document predicate. Other causes of CUA failures are outside its scope.

## Safety and scope

- Supply the exact helper path yourself. **Drain active requests and manually stop Codex and all processes that may use or update the helper first.** Do not patch while an update is running. The tool does not stop, drain, restart, watch, or automatically patch anything. An updater can replace a patched helper; inspect the new file separately and assess it before any manual action.
- Back up the exact original executable to a safe location before applying. An existing Authenticode signature will report **HashMismatch** after modification. Restore only reconstructs the recognized bytes; it does not authenticate the file or repair unrelated changes. Verify signature and provenance independently after restoration, or reinstall from a trusted official source.
- An exclusive Windows handle is required for apply and restore, so an incompatible active handle causes failure rather than a write. Keep the workload drained until the operation completes. `inspect` is read-only and is not a lock or a promise that a file cannot change later.
- Matching is deliberately narrow: PE32+ x64, one executable `.text`, one contextualized `document` string in non-executable `.rdata`, a unique RIP-relative `lea r8` reference, and the complete known 42-byte predicate plus neighboring instructions. The repaired state requires the exact replacement and neighboring bytes, no remaining document LEA, and the same unique literal context. Restore recomputes the original RIP displacement from PE RVAs and checks the reconstructed predicate. Different layouts, other uses of `document`, unknown or potentially upstream-fixed predicates, and ambiguous matches fail closed. Some otherwise valid versions may be rejected.
- This is byte-pattern recognition, not a disassembler, version/provenance check, or proof that matching code is reachable. An unrelated or upstream-fixed binary with identical matching bytes cannot be distinguished from this repair. Do not run it on an upstream-fixed release or an untrusted image. Review the release and retain a backup; prefer an official fix.
- No whole-file hash is used as an authorization gate. SHA-256 is printed only for diagnostics; a match does not establish trust. The verified offline 0.7.17 repaired copy has SHA-256 `0a8fe73a9f95cf2ac741ae5267ec9fe57f7ee26e010621acf0fbe2727e5dbd60`; that is not a promise about other builds.

## Use

Python 3 with the standard library is sufficient. From the repository root, substitute your explicit path for `<helper>`; the typical installed location is under `%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\<runtime-id>\bin\node_modules\@oai\sky\bin\windows\codex-computer-use.exe`. Do not run these commands until you have completed the safety steps above.

```powershell
python .\scripts\windows\desktop-engine\repair-cua-document-role.py inspect "<helper>"
python .\scripts\windows\desktop-engine\repair-cua-document-role.py apply "<helper>"
python .\scripts\windows\desktop-engine\repair-cua-document-role.py restore "<helper>"
```

The commands emit JSON and return nonzero on error. Inspect may run on other platforms; writes require Windows. Apply and restore are idempotent for recognized states. A write changes only the 42-byte predicate, flushes it, and compares the entire file with the expected image. On a write or readback error, the tool attempts to restore and verify the entire pre-operation image; if rollback also fails, do not use the file and recover from the trusted backup or reinstall. Hardware failure or interruption can prevent rollback; the operation is not crash-atomic.

## Tests

Run `python test/windows-cua-document-role-repair.test.py -v` from the repository root. The standard-library unittest suite covers synthetic relocated PE images, refusal cases, exclusive handles on Windows, rollback, and, if available under `PI_SCRATCH_DIR`, the offline repaired 0.7.17 copy. It never writes the installed helper. The native UI behavior is not exercised by these tests.
