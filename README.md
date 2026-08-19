# pi-hyprsh

A [Pi](https://github.com/earendil-works/pi) extension pack: single-line footer with quota, a reason and timing header on tool calls, context inspection views, provider-neutral web search and fetch, a todo panel for the model's plan, and an engineering constitution in the system prompt.

## Install

```bash
pi install git:github.com/hyprsh/pi-hyprsh
```

Or, from a clone:

```bash
pi install .        # every session
pi -e .             # one run, global settings untouched
```

No build step — Pi loads the TypeScript through jiti. Requires Node 22.19+ and Pi 0.84.0+, matching Pi's own floor.

Only one extension may own the footer. `web_search` / `web_fetch` collide with `pi-web-access`, `ask_user_question` with `@juicesharp/rpiv-ask-user-question`, and `todo` / `/todos` with `@juicesharp/rpiv-todo`. Do not run those alongside this pack.

`task` spawns child pi processes that run tools with your permissions. A child inherits this pack, and its tool allowlist never includes `task`, so delegation cannot nest. `scout` and `reviewer` have no `write` or `edit` tool, but they do have `bash`, so they are no-edit rather than sandboxed. Agents are defined in [`lib/agents/definitions/`](lib/agents/definitions) and children inherit the dispatching session's model unless a definition names its own.

## Features

| Feature | What you get |
|---|---|
| **Footer** | One line: cwd, model:thinking, tokens/s, context %, and subscription quota per window with a live reset countdown. On a narrow terminal the line wraps at segment boundaries rather than losing its tail. Anthropic, OpenAI Codex and xAI are read from your existing sign-in. Percentages turn amber at 70 and bold red at 90. |
| **Reason** | Every built-in tool, plus `web_search`, `web_fetch` and `ask_user_question`, takes a required `reasoning` argument, stripped again before the call runs. Execution, result rendering, diffs and `ctrl+o` stay native. `todo` is exempt: the list itself says what it is for. |
| **Compact** | Every tool this pack registers renders its own frame instead of pi's padded box, dropping the two blank lines around each call — a read is two lines: header, call. Above the call sits one header line, `[bash] Confirm the editor is free -> 0.3s done`: tool name, reason, and state — `-> running` while `execute` is in flight, `-> 0.3s done` or `-> 0.3s error` once it returns, nothing at all for a call replayed from a session, which never ran here. The one-column indent and the pending/success/error tint are kept, and bash's own `Took 0.3s` trailer is dropped since the header already carries it. |
| **Context** | `/context` shows what occupies the model context as a proportional map; `/context injections` shows the hidden parts — base prompt, tool definitions, skills, memory files, extension additions — as a previewable tree. `↑↓`/`jk` to move, `Enter` to preview, `Z` to zoom the map, `Esc`/`q` to close. |
| **Web** | `web_search` across SearXNG, Brave, Exa, OpenAI and xAI, and `web_fetch` with Readability/PDF extraction and SSRF checks. Raw provider results, no model-written answers, nothing persisted. Every provider is free at the point of use: two ride subscriptions you already hold, Brave is its free tier, SearXNG is your own instance, Exa is its keyless endpoint. Nothing here bills per query, so a wide fan-out cannot run up a bill. |
| **Ask** | `ask_user_question` puts up to four questions to you with 2-4 written-out options each — the recommended one first and labelled `(recommended)` — a free-text row and optional multi-select, instead of the model guessing. Multi-question runs are prefixed `[1/3]` so you see where you are. Built on pi's own dialogs, so it works in TUI and RPC hosts. |
| **Thinking** | A middle ground between pi's `hideThinkingBlock` on and off: once a thinking block is finished it collapses to one line per thought — bold section headers kept whole, every other paragraph reduced to its opening sentence, list items one line each, capped at 12 lines with a `… 8 more lines` marker. Streaming reasoning is left untouched so you can still watch it live. Display-only: the full text stays in the session and in model context. Set `"thinking": { "mode": "full" }` to turn it off. |
| **Todo** | A `todo` tool the model calls with the whole task list, a panel above the editor showing progress as `Todos (2/7)` with ✔ ▶ ○ ⊘ rows, and `/todos` to print the list. Each result carries the post-call snapshot and the list is replayed from the session branch, so it survives `/reload`, forks and compaction with no disk writes. A step the model decides against stays in the list as `skipped` and must carry a reason, so a plan cannot quietly lose work. The panel caps at 12 lines — settled rows are dropped first — and disappears once everything is done. |
| **Task** | A `task` tool that delegates bounded work to child agents, each a separate pi process with its own context window. The brief is a schema rather than a convention: goal, context, acceptance criteria and verification commands are required fields, so an assignment a child could not act on alone cannot be sent, and the standing prohibitions — no nested delegation, no out-of-scope edits, no unverified completion — are added rather than asked for. Writable scope is a list of paths, so two units claiming the same file, or a writable path handed to a read-only agent, are rejected before anything spawns. Results put the child's verdict next to the files and commands the runtime observed from its tool calls, so a claim and the evidence for it can be seen to disagree. Fan-out is measured against your remaining subscription quota: refused past the critical threshold, serialised past the warning one. Bundled agents are `scout` (read-only recon), `reviewer` (read-only critique) and `worker` (bounded implementation). `scout` asks for `model: cheapest` and so runs on the least expensive model your current provider offers, since reconnaissance is search and summarise; `reviewer` and `worker` name no model and keep the session's, so review quality and written code are untouched. Override per agent with `agents.models`, as `provider/id` or a bare id, checked against the live model registry and ignored if it is not available — so a config written for one provider cannot break dispatch on another. Children are always spawned with the provider spelled out, since 221 of the models pi ships share an id with another provider. Thinking level is separate and ships no default: children follow your global `defaultThinkingLevel` unless you pin one per agent with `agents.thinking`. Measured on a scout task, `low` and `high` produced 311 and 328 reasoning tokens respectively — the budget is a ceiling, not a target, so a shipped default would have bought nothing. |
| **Constitution** | [`lib/constitution/AGENTS.md`](lib/constitution/AGENTS.md) — truthfulness, safety, and the rules against claiming unverified work or weakening a check — appended to the system prompt each turn. Only what must never be one file read away from being skipped: 478 tokens always on, down from 755 before the method moved into the skill. Delete a duplicate `~/.pi/agent/AGENTS.md` or the rules are sent twice. |
| **Skill** | [`skills/hyprmode`](skills/hyprmode) — the working method, loaded on demand. One skill carrying an inline index: five playbooks (investigation, bug fix, feature, refactoring, prototype) and fourteen principles across craft, architecture, verification and delegation, each indexed by one line naming when it applies. The full text sits in leaf files read only when a principle fires, so roughly 5,300 tokens of guidance costs 74 tokens of always-on description. Playbook steps are copied into the todo list verbatim, and a step you decline stays there as `skipped` with its reason. |

Web search works with nothing configured: a provider without a credential is skipped, so a bare install lands on Exa's keyless endpoint.

The default order is by measured latency, since `auto` takes the first provider that answers. `openai` and `xai` are not search APIs but LLM calls that perform a search, so each costs a full inference round-trip. Over five distinct queries the medians were roughly 400ms for a local SearXNG, 1.3s for Exa, 1.4-4.2s for Brave and 7.5-10.4s for the two subscriptions. This tool returns raw provider results either way, so twenty times the wait buys nothing. Reorder `web.search.priority` if you would rather have the synthesised ranking.

## Configuration

`~/.pi/agent/pi-hyprsh.json`. Everything is optional and every feature is on by default.

```json
{
  "features": { "footer": true, "reason": true, "compact": true, "context": true, "web": true, "constitution": true, "ask": true, "todo": true, "task": true },
  "thinking": { "mode": "summary" },
  "agents": {
    "models": { "scout": "anthropic/claude-haiku-4-5" },
    "thinking": { "scout": "low" }
  },
  "footer": {
    "segments": { "cwd": true, "model": true, "tps": true, "context": true, "quota": true },
    "thresholds": { "warning": 70, "critical": 90 }
  },
  "web": {
    "search": {
      "priority": ["searxng", "brave", "exa", "openai", "xai"],
      "timeoutMs": 60000,
      "deadlineMs": 15000,
      "cacheTtlMs": 300000,
      "retries": 2,
      "braveApiKey": "$BRAVE_API_KEY",
      "searxngBaseUrl": "http://searx.lan:8080"
    },
    "fetch": {
      "timeoutMs": 30000,
      "maxBytes": 8388608,
      "maxRedirects": 5,
      "maxChars": 50000,
      "extractorUrl": "https://r.jina.ai",
      "extractorApiKey": "$JINA_API_KEY"
    }
  }
}
```

A missing or malformed file falls back to defaults. The `web` section is validated instead, and an invalid key fails the next tool call naming the offending path rather than breaking startup.

## Credentials

| Provider | Credential |
|---|---|
| `openai` | Codex sign-in via `/login`, else `OPENAI_API_KEY` |
| `xai` | SuperGrok / X Premium sign-in, else `XAI_API_KEY` |
| `brave` | `BRAVE_API_KEY`, or `web.search.braveApiKey`; the free tier is enough for normal use |
| `exa` | none; the keyless endpoint is rate limited when busy |
| `searxng` | `SEARXNG_BASE_URL` |

Config values may be a literal or a `$VAR` / `${VAR}` reference; each also falls back to the environment variable above, so nothing has to be written to the file. Keys are sent as request headers only, never logged or cached, and a credentialed request never follows a redirect.

## Development

Known gaps and the next pieces of work are in [`BACKLOG.md`](BACKLOG.md).

```bash
npm install
npm run check       # biome + tsc --noEmit + node --test
npm test            # just the tests
npm run format
```

```
index.ts              entry, registers enabled features
skills/hyprmode/   the router skill: playbooks, principles, commit format
lib/config.ts         feature flags
lib/footer/           setFooter component and segment renderers
lib/quota/            per-provider subscription usage
lib/reason/           the reasoning argument added to every wrapped tool
lib/compact/          call framing and header line, shared by every tool in the pack
lib/agents/           subagent runtime: spawns a child pi, reads its result off the event stream
lib/task/             the task tool: brief schema, ownership checks, quota gate
lib/context/          /context usage and /context injections views
lib/web/              web_search and web_fetch
lib/ask/              ask_user_question on pi's native dialogs
lib/thinking/         condensed rendering of finished thinking blocks
lib/todo/             todo tool, editor panel and /todos
lib/constitution/     rules appended to the system prompt
test/                 node:test suites, run by npm test
```

Never commit `~/.pi/agent/auth.json`, API keys or OAuth tokens.

## Credits

The todo panel follows the design of [`@juicesharp/rpiv-todo`](https://pi.dev/packages/@juicesharp/rpiv-todo) (MIT): a whole-list tool, session replay instead of disk state, and a row budget that sheds completed tasks first. The subagent runtime resolves the pi entry point the way pi's own [`examples/extensions/subagent`](https://github.com/earendil-works/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) (MIT) does, and the delegation brief follows the section contract in [`pstack`](https://github.com/cursor/plugins/tree/main/pstack) (MIT, Lauren Tan). The `/context` views are ported from [`pi-context-view`](https://github.com/dimk90/pi-context-view) (MIT, Dmitry Makarov). Quota endpoints were learned from [`@juanbenjumea/pi-dynamic-footer`](https://www.npmjs.com/package/@juanbenjumea/pi-dynamic-footer) (MIT) and [`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota/pull/165).

MIT
