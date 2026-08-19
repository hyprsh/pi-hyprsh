# Backlog

Ordered by value. Each item says what is wrong now, not just what to build.

Status of the previous round: the subagent runtime, the `task` tool, the
`hyprmode` skill, the constitution kernel and the web provider set all shipped
and were verified by hand. What follows is what that round left behind.

Since then: a test suite and CI exist (item 1, partly), and writing children are
serialised rather than given worktrees (the decision at the end).

---

## 1. Regression protection — *started*

**Shipped.** `npm test` runs `node --test` with no new dependency, `npm run
check` now ends in it, and `.github/workflows/check.yml` runs the lot on Node
24. 39 tests cover `lib/task/brief.ts`, `lib/task` dispatch and `lib/agents`.
Two were mutation-checked rather than merely observed green: breaking `overlaps`
to a bare `startsWith`, and un-serialising the writers, each turned exactly one
test red.

**Still uncovered:**

| Function | The case that will break silently |
|---|---|
| `lib/todo/model.ts` `parseTodos` | a skip with no reason, or a whitespace-only one, is rejected |
| `lib/web/config.ts` validation | a bad key throws naming the offending path |
| `lib/agents/run.ts` `recordEvidence` | `file_path` and `path` both count as a change; `bash` records the command |
| `lib/task/render.ts` `panelLines` | never rendered, never asserted (see item 4) |

**Size:** ~80 lines of test.

---

## 2. Close the delegation loop in `/context`

The argument for subagents is `guard-the-context-window`, and this is the only
pack that can *show* that window rather than assert about it. But `task` reports
nothing about what delegation saved, so the loop the design opened is still
open.

Make a `task` result carry the child's context usage, and have `/context`
attribute it: how much stayed out of this window because a child read it
instead.

**Size:** small in `lib/task`, moderate in `lib/context`.

---

## 3. Cheap models for cheap agents — *done*

`lib/agents/model.ts` resolves a child's model from one field: an
`agents.models` entry in `pi-hyprsh.json` wins, otherwise the `model` line in
the definition's frontmatter. The value is a model ID, a `provider/id`, or
`cheapest`, which resolves to the least expensive model the registry reports as
available *on the session's own provider*. Anything named but unavailable is
dropped in favour of inheriting, so a config written for one provider cannot
break dispatch on another.

`scout` declares `model: cheapest`; `reviewer` and `worker` deliberately name
nothing. An earlier cut had a separate `tier: cheap` field, which was one
vocabulary too many for what is just a model name.

Thinking level is a separate axis, settable only in config via
`agents.thinking`. **No default ships, and the reason is measured.** An earlier
commit claimed a child left at `high` "spends the saving straight back". That
was asserted, not tested, and it is wrong: `budget_tokens` is a ceiling rather
than a target, and the same scout task used 311 reasoning tokens at `low`
against 328 at `high`, both an order of magnitude under either cap. The `low`
runs also took 3-4 turns against 2 and cost more overall, which hints the
shorter leash is paid for in extra tool calls — n=2 per arm, so a hypothesis,
not a finding.

What the live dispatch did establish is that omitting `--thinking` hands the
child the user's global `defaultThinkingLevel`, not the model's own. That is
worth knowing and worth being able to override; it is not worth a shipped
opinion.

Measured on an `anthropic/claude-opus-5` session: the tier picks
`claude-haiku-4-5`, which is 5× cheaper on both input and output. A direct
spawn on that model returned `SPAWN_OK` for $0.001867 against roughly $0.0093
for the same call on opus.

Children are spawned with `provider/id`, never a bare ID. Review caught this:
221 of the 1267 models pi ships are offered by more than one provider,
`claude-haiku-4-5` among them, and pi's CLI only rescues a bare ambiguous ID
when exactly one matching provider is authenticated — with two it errors and the
child dies at spawn. The inherit path had the same latent bug before this round
and is fixed with it.

**Not done:** no live `task` dispatch has run since the change, because pi loads
the extension at session start. The resolution is covered by 19 unit tests and
the qualified spawn was proven by hand, but the two have not been seen joined
up.

---

## 4. Verify what has only been reasoned about

Carried forward honestly. None of these are known broken; none are known good.

- The `task` TUI panel (`lib/task/render.ts` `panelLines`) has never been seen
  rendered. Print mode has no widgets.
- The quota gate's refusal branch has never fired against a real
  near-exhausted allowance.
- The agents abort path is wired to `signal` but never exercised.
- The `auto` fallback chain has never been watched handing off from a failed
  provider to the next.
- Whether the model reliably *loads* `hyprmode` when it should. pi's own docs
  warn that models often skip skill loading. If it under-fires, the fix is the
  pointer in the constitution kernel.

---

## 5. `lib/context` earns its size or loses some

2873 lines, 38% of the TypeScript in the pack, untouched and unverified for two
rounds. It is the module with the least obvious daily payoff and the largest
footprint. Item 2 is the strongest argument for keeping all of it; if item 2
does not happen, revisit what `usage-view.ts` (731 lines) is buying.

---

## 6. Brave's position in the provider order

Its latency was the least stable thing measured: 626ms to 4.2s, with the median
moving 3× between two runs. It currently sits second, ahead of Exa, on evidence
that does not really support the precision.

Re-measure over more runs, at different times of day, and move it behind Exa if
it does not hold up.

---

## 7. Editorial pass on the skill

`skills/hyprmode` is 448 lines of method prose, written in one pass and never
read by a human. It is the most subjective thing in the pack and it shapes
every non-trivial task. Read it, cut what does not earn its place, and make the
voice yours.

---

## Decision: automatic worktrees for subagents

**Question.** Should `task` give each writing child its own `git worktree`
instead of running every child in the session's working tree?

**Where this stands today.** Children all run in `session.cwd`. Ownership is
enforced only by `conflicts()` rejecting overlapping *declared* writable paths,
plus a `FORBIDDEN` line asking the child to stay in scope. Nothing at the
filesystem level stops a child writing anywhere.

### For

- **Isolation becomes real.** Right now a child staying in its lane is a promise
  in a brief. A worktree makes it a property of the filesystem.
- **Verification stops lying.** A child running `npm run check` in the shared
  tree sees its siblings' half-finished edits. Its verdict is then about a state
  that never existed and will never exist again.
- **Concurrency could rise.** `MAX_CONCURRENT` is 3 partly because concurrent
  writers are dangerous. Isolated writers are not.
- **Review gets cleaner.** `git diff main...child-branch` per unit, instead of
  one tangled diff in the parent tree.
- **Failure is free.** Discard a bad unit by deleting a directory, with nothing
  to unpick in the main tree.
- **Precedent.** OMP exposes `isolated: true` and pstack's orchestrate assumes
  worktrees, so the shape is proven elsewhere.

### Against

- **A fresh worktree has no `node_modules`,** so `npm run check` fails there
  with `biome: command not found` until something installs them. This is less
  of an obstacle than it first appears: a cold `npm install` in a worktree
  measured **3.5s** and every check then passed. It is a step to automate, not
  a wall.
- **Disk, at npm's marginal cost.** Each additional worktree consumed **354MB**
  measured against filesystem free space. Three concurrent writers is roughly a
  gigabyte per dispatch, created and destroyed.
- **The parent's uncommitted work is invisible.** A worktree starts from a
  commit. Today's in-flight edits — the usual state — would not be there unless
  the parent commits or stashes first.
- **Integration becomes a merge problem** the root now owns, including conflicts
  between siblings.
- **Requires a git repo.** Falls apart in a plain directory.
- **Lifecycle burden.** Creating, tracking, pruning, and cleaning up orphans
  after a crash or an abort.
- **Buys nothing for two of three agents.** `scout` and `reviewer` have no
  `write` or `edit` tool. Only `worker` writes.
- **The exposure is narrow.** It only matters for two or more `worker` units in
  a single call, which is not the common case.

### Recommendation — *serialised writers shipped*

**Worktrees are not built. Writers are serialised instead.**

`dispatchPhased` in `lib/task/index.ts` runs read-only units together as before,
then writing units one at a time, keeping the caller's order in the results. A
writer therefore never observes a sibling's half-finished edits, and
`npm run check` still works because nothing moved out of the session's tree.
Eight tests in `test/dispatch.test.ts` assert it against a recorded timeline
rather than against wall-clock timing.

Only `worker` writes, so nothing changes for a `scout` or `reviewer` fan-out —
asserted in `test/agents.test.ts` so a new writing agent cannot be added without
noticing. The cost is wall clock on multi-writer dispatches, which are rare.

Revisit worktrees if and when multi-writer parallelism proves it matters — and
treat it then as the environment-provisioning project it really is, not a git
flag: install automation per tree, uncommitted-state handling, integration and
cleanup.

### Would pnpm help?

Asked because pnpm's content-addressable store should make per-worktree
`node_modules` nearly free. Measured, on this repo:

| | npm | pnpm |
|---|---|---|
| Cold install in a worktree | 3.52s | 3.97s |
| Disk consumed per extra worktree | 354MB | **7MB** |
| `npm run check` afterwards | passes | **fails** |

The disk result is real and large: 50× less per worktree, which is exactly the
cost that makes many isolated children expensive. Speed is a wash.

But pnpm currently **breaks the typecheck**. Its strict layout resolves two
copies of `typebox` — `1.3.7` for `@earendil-works/pi-coding-agent` and
`1.3.15` for this package — so `TObject` from one is not assignable to
`TObject` from the other and `lib/reason/index.ts` fails to compile. npm hoists
to a single copy and the types line up. Two quick fixes were tried and neither
worked: a `pnpm.overrides` pin to `1.3.7` still produced both copies, and
`node-linker=hoisted` in `.npmrc` did not take effect in the test.

**Conclusion: do not switch now.** The only advantage pnpm offers here is disk
cost per worktree, and worktrees are deferred, so the benefit is currently
hypothetical while the broken typecheck is concrete. Revisit pnpm *together
with* worktrees if they are ever built, and solve the typebox resolution
properly at that point rather than with a flag.
