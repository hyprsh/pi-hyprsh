# Refactoring

A behaviour-preserving change to structure: rename, extract, inline, dedupe, move.

1. **Establish the before.** Run the tests, the type check and the build now,
   and record the result. Without this you cannot claim you preserved anything.
2. **State the shape you are moving to** and why it is better in one sentence.
   "Cleaner" is not a reason. Fewer layers between a question and its answer,
   one owner for a piece of state, an illegal state removed — those are.
3. **Subtract first.** Delete dead code, unused branches and one-caller wrappers
   before restructuring what is left. The simpler base is often the whole fix.
4. **Move callers and delete the old path in the same change.** No compatibility
   shim, no deprecation window, no second way to do it.
5. **Change structure or behaviour, never both.** If you find a bug, stop and
   note it. Fixing it here makes the diff unreviewable, because nothing
   separates the intended no-op from the intended change.
6. **Rerun exactly the checks from step 1.** Same commands, and the results must
   match. Report both.
7. **Read the diff as a reviewer.** Every hunk should be explainable as the
   named transformation. Anything else is scope creep.

The reply names the transformation, the evidence behaviour is unchanged, and
anything you found and deliberately left alone.
