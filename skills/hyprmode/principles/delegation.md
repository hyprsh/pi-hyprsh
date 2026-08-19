# Delegation principles

## Guard the context window

Context is the scarcest resource in a long session, and it degrades quietly:
nothing fails, answers just get worse as the useful facts are crowded out by
raw payloads.

Route bulk to a `task` child and keep only the summary. Worth delegating: a
wide search across an unfamiliar tree, reading many files to answer one
question, an independent review of a diff, a mechanical sweep whose output you
do not need to see.

Not worth delegating: work that is tightly coupled to what you are doing now.
Children cannot talk to each other or to you, so anything needing back and
forth costs more in briefing than it saves in tokens.

The `/context` view shows what is actually occupying the window. Look before
you assume.

Applies when: about to read something large, or planning a fan-out.

## Never block on the human

For reversible work, proceed and present the result. A human course-correcting
a real diff is faster and better informed than a human answering a hypothetical.

Before asking anything, classify the question:

- **Observable by running something** — behaviour, timing, output, layout,
  whether a library supports it. Not the user's to answer. Run the experiment.
  See the prototype playbook.
- **A genuine preference or product call** — what it should feel like, what
  matters more. Ask, with written-out options.
- **Irreversible or outside your authority** — deploying, deleting data,
  force-pushing, messaging someone. Always ask.

The default is to act, not to check in. Reserve the interruption for the cases
where it is the only way to find out.

Applies when: you are about to ask "should I…" about something you could
simply do and undo.
