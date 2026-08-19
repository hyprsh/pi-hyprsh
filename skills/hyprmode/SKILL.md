---
name: hyprmode
description: The working method for non-trivial engineering work. Routes a task to a playbook (investigation, bug fix, feature, refactoring, prototype) and indexes the design, architecture, verification and delegation principles. Use for any change that is not a one-line edit or a direct question.
---

# hyprmode

The always-on constitution says what you must never do. This says how to work.

## Using it

1. Match the task to a playbook below. Open that file.
2. Copy its steps into a todo list **verbatim, before** any task-specific steps
   and before you plan the task yourself. The failure this prevents is reading a
   playbook and then writing a bespoke plan that quietly drops its named steps.
3. A step you decide against stays in the list as `skipped` with a reason. The
   `todo` tool requires the reason, so a silent drop is not available to you.
4. Read a principle in full before you apply it. When you cite one in your
   reply, name the decision it changed. A citation with no decision behind it
   means you did not read it.

## Playbooks

| Task | Playbook |
|---|---|
| A read-only question: how does X work, why was Y built this way, are we sure about Z | [playbooks/investigation.md](playbooks/investigation.md) |
| A defect to reproduce, root-cause and fix with runtime evidence | [playbooks/bug-fix.md](playbooks/bug-fix.md) |
| New or changed behaviour | [playbooks/feature.md](playbooks/feature.md) |
| A behaviour-preserving change to structure: rename, extract, inline, dedupe, move | [playbooks/refactoring.md](playbooks/refactoring.md) |
| A fork that an experiment could settle, or a design worth seeing before committing | [playbooks/prototype.md](playbooks/prototype.md) |

No playbook fits? Say so, then write the steps you will follow before you start,
in the same shape: numbered, each ending in something checkable.

## Principles

One line each, naming when it applies. Read the leaf before applying it.

### Craft — [principles/craft.md](principles/craft.md)

- **Laziness protocol.** Sizing a diff, or tempted to add a layer. Bias to deletion and the smallest change that works.
- **Subtract before you add.** Sequencing an addition or a rewrite. Remove dead weight first, then build on the simpler base.
- **Minimise reader load.** Code that is hard to trace. Count the layers between question and answer; collapse one-caller wrappers.
- **Build the lever.** Any repetitive or wide change. Write the script that does it or proves it; the tool is what a reviewer can rerun.
- **Encode lessons in structure.** You are writing the same instruction a second time. Make it a type, a lint or a check instead of more prose.

### Architecture — [principles/architecture.md](principles/architecture.md)

- **Model the domain.** Logic that branches a lot or repeats a shape assumption. Encode it in a structure, not scattered conditionals.
- **Type system discipline.** Designing a type or a signature. Make illegal states unrepresentable; parse external data at the boundary.
- **Boundary discipline.** Wiring validation or error handling. Guards at the edges, trust internal types, keep the middle pure.
- **Idempotent operations.** Commands and lifecycle steps that run amid retries. Converge to the same end state.
- **Migrate then delete.** A new internal API with old callers. Move them and delete the old one in the same change; no compatibility layer.
- **Study the precedent.** Any design with an established answer. Find how mature products solved it before inventing.

### Verification — [principles/verification.md](principles/verification.md)

- **Prove it works.** Before declaring done. Verify against the real artifact, not a proxy and not "it compiles".
- **Fix root causes.** Debugging. Reproduce first, ask why until you reach the cause, and resist the guard that only silences the symptom.
- **Sequence verifiable units.** Multi-step work. Break it so each unit ends in a check, and order delivery so the sequence proves itself.

### Delegation — [principles/delegation.md](principles/delegation.md)

- **Guard the context window.** Wide searches, long files, bulk reading. Send it to a `task` child and keep the summary, not the payload.
- **Never block on the human.** Tempted to ask about reversible work. Proceed and present the result. If an experiment could answer it, run the experiment.

## Writing

Commit messages follow [references/commits.md](references/commits.md).

Your reply is a surface like any other. Short declarative sentences, one thought
each. Say what changed for the person who will use it and for the next engineer
who will own it, before any implementation detail. Never claim a link, a
citation or a command you did not produce this session.
