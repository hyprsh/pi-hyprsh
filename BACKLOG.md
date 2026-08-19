# Backlog

Ordered by value. Each item says what is wrong now, not just what to build.

Status of the previous round: the subagent runtime, the `task` tool, the
`hyprmode` skill, the constitution kernel and the web provider set all shipped
and were verified by hand. What follows is what that round left behind.

---

## 1. Regression protection

**No automated tests exist.** No framework, no `test` script, no CI. Every check
so far was a throwaway probe, run once, observed, deleted.

That leaves pure functions with genuinely tricky edge cases protected by
nothing:

| Function | The case that will break silently |
|---|---|
| `lib/task/brief.ts` `overlaps` | `lib/ab` vs `lib/abc` must *not* conflict; `lib/` vs `lib/a.ts` must |
| `lib/task/brief.ts` `conflicts` | duplicate names, writable paths given to a read-only agent |
| `lib/agents/run.ts` verdict parsing | the `VERDICT:` line is found, case-insensitive, and stripped from the report |
| `lib/agents/types.ts` `addUsage` | totals and nested `cost` both accumulate |
| `lib/todo/model.ts` `parseTodos` | a skip with no reason, or a whitespace-only one, is rejected |
| `lib/web/config.ts` validation | a bad key throws naming the offending path |

Node 22 has a built-in runner, so this needs no new dependency:
`node --test --experimental-strip-types`. Add `npm test`, wire it into
`npm run check`, and add a GitHub Actions workflow that runs it.

Start with `lib/task/brief.ts` and `lib/agents`, which are the newest and the
least exercised.

**Size:** ~200 lines of test, plus a workflow file.

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

## 3. Cheap models for cheap agents

Children inherit the dispatching session's model, so a `scout` running `ls`
burns the same tokens as the parent. Inheriting is the safe default — a wrong
model ID is a hard failure — but the cost win is obvious and unclaimed.

Options, cheapest first:
- A `model` line in the agent definition, resolved against the live registry,
  ignored when it does not match. Needs the registry check to avoid the hard
  failure.
- A `models` map in `pi-hyprsh.json` keyed by agent name.

**Size:** small, once model resolution is decided.

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

- **A fresh worktree has no `node_modules`.** Verified: `git worktree add` then
  `npm run check` fails with `biome: command not found`. Since every brief is
  required to carry verification commands, worktrees would break the pack's
  central discipline on day one. Fixing it means `npm install` per worktree
  (slow, and duplicated disk per child) or symlinking (fragile, wrong for
  native deps). **This is not "add a git command", it is environment
  provisioning for child processes.**
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

### Recommendation

**Do not build worktrees yet. Serialise writers instead.**

If a dispatch never runs two writing children at once, the shared tree is safe
for the same reason single-threaded code needs no locks, and it costs about five
lines: partition the briefs by whether the agent can write, run read-only units
concurrently as now, and run writers one after another.

That removes the actual hazard immediately, keeps `npm run check` working, and
costs wall-clock only on multi-writer fan-outs, which are rare. Revisit
worktrees if and when multi-writer parallelism proves it matters — and treat it
then as the environment-provisioning project it really is, not a git flag.

**Size:** ~5 lines for serialised writers. Worktrees, done properly, are a
multi-day feature.
