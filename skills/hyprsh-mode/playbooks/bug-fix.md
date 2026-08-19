# Bug fix

A defect to reproduce, root-cause and fix with runtime evidence.

1. **Reproduce it first.** Get the failure to happen on demand, and record the
   exact command and output. Until you have this you are guessing, and a fix
   with no reproduction cannot be shown to work.
2. **Write the failing check** when there is a cheap local test path. Watch it
   fail for the right reason before you touch the code.
3. **Find the root cause.** Ask why until you reach something that explains the
   whole symptom. Stop when the answer would still be true after your fix.
   Resist the nil-check that silences the crash without explaining it.
4. **Name the cause in one sentence** before writing the fix. If you cannot,
   you have not found it yet.
5. **Fix the cause, not the symptom.** Smallest change that removes it.
6. **Rerun the reproduction from step 1.** It must now pass, and you report its
   real output.
7. **Run the surrounding checks** — the project's tests, types and linter — and
   report exactly what ran.
8. **Look for the same mistake elsewhere.** One instance of a pattern usually
   has siblings. Name them; do not silently fix them in this change.

The reply states the symptom, the cause, the fix, and the evidence it works.
