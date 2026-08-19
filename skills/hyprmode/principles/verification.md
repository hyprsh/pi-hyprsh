# Verification principles

## Prove it works

Before declaring anything done, verify against the real artifact. Run the
feature. Read the actual value. Inspect the diff you actually produced.

These are not proof:

- "It compiles" or "the types pass".
- "The test I wrote passes" — you wrote the test from the same misunderstanding.
- A subagent's report that it verified its own work.
- A successful exit code, which only says the process ended.

The question is always: what did I observe that would be false if this were
broken? If the answer is nothing, you have not verified it.

Applies when: after completing a task, before saying it is done.

## Fix root causes

Trace each symptom to the thing that explains it, and fix it there.

1. Reproduce it on demand. Without this you cannot know when it is fixed.
2. Ask why until the answer would still be true after your change.
3. Fix that.

The failure mode is the guard that silences the symptom: a null check where the
null should never have been produced, a retry around a race, a caught exception
that hides an unhandled case. Each one converts a loud bug into a quiet one and
leaves the cause in place for the next person.

If you must ship a mitigation before the real fix, say so explicitly and say
what the real fix is.

Applies when: debugging anything.

## Sequence verifiable units

Break multi-step work so each unit ends in a state you can check, verify it
before starting the next, and order delivery so the sequence proves itself to a
reviewer.

The failure this prevents is the twelve-file change where something broke
somewhere and now every step is suspect at once. Small verified units mean a
regression has one obvious owner.

For commits and PRs, this is the same rule: each one should stand on its own and
leave the tree working.

Applies when: sweeps, migrations, runs of similar edits, and stacking commits.
