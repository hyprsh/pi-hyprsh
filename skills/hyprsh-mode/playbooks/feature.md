# Feature

New or changed behaviour, built from a named data shape.

1. **Name the data shape first.** Before any logic, write the types: what the
   thing is, what states it can be in, what crosses each boundary. Make the
   illegal states unrepresentable now, while it is free.
2. **Write the caller before the implementation.** Sketch how it will be used.
   A signature that is awkward to call is wrong however clean it looks inside.
3. **Find the precedent.** Something established has solved this. Read how, and
   take the proven shape rather than inventing one.
4. **Decide what you are not building.** Name the cases you are deliberately
   leaving out. No configuration or indirection for a requirement nobody has.
5. **Build the smallest version that works end to end.** One path, working,
   before any breadth. Never trade a working product for unfinished structure.
6. **Verify against the real artifact.** Run the feature. Read the actual value.
   "It compiles" and "the test I just wrote passes" are not the same as "it
   does the thing".
7. **Run the project's checks** and report what ran.
8. **Reread your own diff** for scope creep, leftover scaffolding and comments
   that narrate instead of explaining why.

The reply says what the user can now do that they could not before, then what
the next engineer inherits.
