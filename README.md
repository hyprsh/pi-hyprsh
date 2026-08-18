# pi-hyprsh

A [Pi](https://github.com/earendil-works/pi) extension pack: single-line footer with quota, a reason line on built-in tools, context inspection views, provider-neutral web search and fetch, and an engineering constitution in the system prompt.

## Install

```bash
pi install git:github.com/hyprsh/pi-hyprsh
```

Or, from a clone:

```bash
pi install .        # every session
pi -e .             # one run, global settings untouched
```

No build step — Pi loads the TypeScript through jiti. Requires Node 22+ and Pi 0.84.0+.

Only one extension may own the footer. `web_search` / `web_fetch` collide with `pi-web-access`, and `ask_user_question` with `@juicesharp/rpiv-ask-user-question`. Do not run those alongside this pack.

## Features

| Feature | What you get |
|---|---|
| **Footer** | One line: cwd, model:thinking, tokens/s, context %, and subscription quota per window with a live reset countdown. Anthropic, OpenAI Codex and xAI are read from your existing sign-in. Percentages turn amber at 70 and bold red at 90. |
| **Reason** | Every built-in tool takes a required `reasoning` argument, rendered as one line above the call. Result rendering, diffs and `ctrl+o` stay native. |
| **Context** | `/context` shows what occupies the model context as a proportional map; `/context injections` shows the hidden parts — base prompt, tool definitions, skills, memory files, extension additions — as a previewable tree. `↑↓`/`jk` to move, `Enter` to preview, `Z` to zoom the map, `Esc`/`q` to close. |
| **Web** | `web_search` across OpenAI, xAI, Exa, Brave and SearXNG, and `web_fetch` with Readability/PDF extraction and SSRF checks. Raw provider results, no model-written answers, nothing persisted. |
| **Ask** | `ask_user_question` puts up to four questions to you with 2-4 written-out options each, a free-text row and optional multi-select, instead of the model guessing. Built on pi's own dialogs, so it works in TUI and RPC hosts. |
| **Constitution** | [`lib/constitution/AGENTS.md`](lib/constitution/AGENTS.md) — truthfulness, safety, workflow, [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), design — appended to the system prompt each turn. Delete a duplicate `~/.pi/agent/AGENTS.md` or the rules are sent twice. |

Web search works with nothing configured: Exa's keyless endpoint is the fallback. A Codex or SuperGrok subscription is used before any API key.

## Configuration

`~/.pi/agent/pi-hyprsh.json`. Everything is optional and every feature is on by default.

```json
{
  "features": { "footer": true, "reason": true, "context": true, "web": true, "constitution": true, "ask": true },
  "footer": {
    "segments": { "cwd": true, "model": true, "tps": true, "context": true, "quota": true },
    "thresholds": { "warning": 70, "critical": 90 }
  },
  "web": {
    "search": {
      "priority": ["openai", "xai", "exa", "brave", "searxng"],
      "timeoutMs": 60000,
      "deadlineMs": 15000,
      "cacheTtlMs": 300000,
      "retries": 2,
      "exaApiKey": "$EXA_API_KEY",
      "braveApiKey": "...",
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
| `exa` | none, or `EXA_API_KEY` to lift the rate limit |
| `brave` | `BRAVE_API_KEY` |
| `searxng` | `SEARXNG_BASE_URL` |

Config values may be a literal or a `$VAR` / `${VAR}` reference; each also falls back to the environment variable above, so nothing has to be written to the file. Keys are sent as request headers only, never logged or cached, and a credentialed request never follows a redirect.

## Development

```bash
npm install
npm run check       # biome + tsc --noEmit
npm run format
```

```
index.ts              entry, registers enabled features
lib/config.ts         feature flags
lib/footer/           setFooter component and segment renderers
lib/quota/            per-provider subscription usage
lib/reason/           reason line wrapper around pi's built-in tools
lib/context/          /context usage and /context injections views
lib/web/              web_search and web_fetch
lib/ask/              ask_user_question on pi's native dialogs
lib/constitution/     rules appended to the system prompt
```

Never commit `~/.pi/agent/auth.json`, API keys or OAuth tokens.

## Credits

The `/context` views are ported from [`pi-context-view`](https://github.com/dimk90/pi-context-view) (MIT, Dmitry Makarov). Quota endpoints were learned from [`@juanbenjumea/pi-dynamic-footer`](https://www.npmjs.com/package/@juanbenjumea/pi-dynamic-footer) (MIT) and [`slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota/pull/165).

MIT
