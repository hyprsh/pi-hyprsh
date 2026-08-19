# Architecture principles

## Model the domain

Get the data structures right and the code becomes obvious. When logic branches
a lot, or the same shape assumption is repeated across files, the domain is
being re-derived at every call site instead of being written down once.

Encode it: a state machine, a typed model, a table or registry, a reducer, the
right collection. Then the conditionals collapse, because the structure already
excludes the cases they were checking for.

Applies when: writing stateful logic, or on the third `if` that tests the same
thing a different way.

## Type system discipline

Make illegal states unrepresentable. A type that admits a value the code cannot
handle is a bug waiting for a caller.

- Prefer a union of valid shapes to one shape with optional fields and a rule.
- Parse external data at the boundary into a type the inside can trust.
- Exhaust variants, so adding one breaks the build instead of falling through.
- Never lie to the compiler. A cast is a claim you are making on your own
  authority; if you cannot justify it in a comment, it is wrong.

Applies when: designing any type or signature.

## Boundary discipline

Concentrate guards where untrusted things enter — CLI arguments, config files,
network responses, external APIs. Inside that line, trust your own types and
keep the logic pure.

The failure this prevents is defensive checks smeared through every function,
which are both noise and a lie: they suggest the value might be invalid here,
which means no reader can tell where validation actually happens.

Applies when: wiring validation, error handling or a framework adapter.

## Idempotent operations

An operation that runs amid crashes, retries and partial prior runs should
converge to the same end state. Ask what happens when it runs twice, and when it
dies halfway and runs again.

Applies when: designing commands, lifecycle steps, migrations or install logic.

## Migrate then delete

When a new internal API replaces an old one, move every caller and delete the
old one in the same change. Do not keep a compatibility layer, a shim or a
deprecation window.

Two ways to do one thing means every reader must learn both, every future change
must touch both, and the old one never dies because nothing forces it to. The
migration you finish is cheaper than the one you leave half done.

Applies when: introducing an internal API while old callers exist.

## Study the precedent

Before designing something with an established answer, find out how mature
products solved it. Adopt the proven shape and its conventions.

This is not deference. It is that a widely used design has absorbed failures
you have not encountered yet, and its conventions are what your users already
know. Deviate deliberately and say why, never by not having looked.

Applies when: any design decision that is not novel to your problem.
