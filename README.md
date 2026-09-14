# shiyi（拾遗）

Centralize the AI chats scattered across every tool you use: local Claude Code / Codex / Gemini CLI
sessions sync automatically, ChatGPT / Gemini Web / Kimi / Grok exports import in one command,
everything is full-text searchable, exportable as Markdown — a personal knowledge base built over time.

All data stays 100% on your machine (`~/.shiyi/shiyi.db`, SQLite + FTS5). Nothing is sent anywhere.

## Quick start

```bash
pnpm install          # node 24 LTS (pinned to 24.21.0 via .node-version; fnm --use-on-cd switches automatically); first run compiles better-sqlite3
pnpm sync             # scan local session sources into the DB (incremental; first run takes ~1-2 min)
pnpm build            # build the web frontend (one-time)
pnpm serve            # start http://127.0.0.1:7420 (with file-watching auto-sync)
```

Day-to-day you only need `pnpm serve`: while it runs, new sessions are picked up automatically
(changes under `~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp` are imported after a 2s
debounce); cloud export packages dropped into `~/.shiyi/inbox/` are processed automatically too.

## Data sources

| Source | Ingestion | Notes |
|---|---|---|
| Claude Code | automatic (`~/.claude/projects/`) | uses AI-generated titles; filters tool-result/sidechain noise |
| Codex | automatic (`~/.codex/sessions/` + `archived_sessions/`) | streaming parse, skips base64 images; filters AGENTS.md/IDE injections |
| Gemini CLI | automatic (`~/.gemini/tmp/*/chats/`) | |
| ChatGPT | import the export zip or the extracted conversations.json | Settings → Data Controls → Export data; `shiyi import xxx.zip` (zip or extracted conversations.json both work); `codex.json` inside the export (cloud Codex tasks) is recognized too |
| Gemini Web | import the Takeout zip | takeout.google.com → select only My Activity → Gemini Apps; `shiyi import takeout.zip` |
| Kimi | import Markdown/JSON | **No official export exists in the web/app** (verified 2026-09: no data-export entry in settings). Practical paths: ① a browser extension that exports MD; ② manually copy the conversation into a Markdown file. Import with `shiyi import kimi.md -s kimi` (`## 用户`/`## Kimi` sections are auto-detected); role-structured JSON is auto-detected too |
| Grok (X) | import zip/JSON/Markdown | ① grok.com → Settings → Data Controls → Download Your Data; ② in-X Grok via the [Enhanced Grok Export](https://github.com/iikoshteruu/enhanced-grok-export) userscript (MD/JSON); ③ pasted conversation Markdown also works (`## User`/`## Grok` sections, or the whole file as a single note) |

Note: in-X Grok and grok.com histories do not fully sync; the userscript path is the most reliable for x.com/i/grok.

## Commands

```bash
shiyi sync [--full]        # incremental sync of local sources + process inbox/; --full reparses everything
shiyi import <file|url...> [-s kimi|grok]   # import cloud export files (zip/md/json/jsonl, auto-detected) or share links
shiyi serve [-p 7420] [--no-watch]      # web UI + file watching
shiyi export -o <dir> [-s <source>]     # export Markdown (Obsidian-compatible, metadata in frontmatter)
shiyi status               # session counts per source
```

### Share-link import (fully automatic)

Public share links created via the in-app "Share" button import directly, no login required:

```bash
shiyi import https://www.kimi.com/share/xxx      # renders headlessly, then structured extraction
shiyi import https://chatgpt.com/share/xxx       # same
shiyi import https://share.gemini.google/xxx     # same
shiyi import https://x.com/i/grok/share/xxx      # in-X Grok: intercepts the page's GraphQL API for structured data
shiyi import https://grok.com/share/xxx          # grok.com shares (DOM extraction, pending real-sample tuning)
```

How it works: an HTTP fast path first (older SSR-rendered pages parse directly); when a
client-rendered shell is detected, headless Chromium launches and extracts per provider — Kimi
intercepts the `GetChatShare` XHR (markdown source + separated thinking + tool calls), ChatGPT uses
`data-message-author-role`, Gemini `.user-query-container`/`.response-container`, and in-X Grok
intercepts the `GrokShare` GraphQL response (`sender: User/Agent` + markdown body — more stable than
DOM). Each link takes ~5-15 seconds.

Dependency: `pnpm add playwright && pnpm exec playwright install chromium` (~120MB, one-time).
The CLI prints a clear hint if it is missing. Re-importing the same link deduplicates automatically;
note that if the same conversation was already imported from an official export, the share version
creates a duplicate (different nativeId) — delete as needed.

(During development, invoke via `pnpm exec tsx src/cli/index.ts <command>`.)

Environment variables: `SHIYI_HOME` (default `~/.shiyi`), `SHIYI_DB`, `SHIYI_INBOX`.

## Search

- SQLite FTS5 + **trigram tokenizer** — friendly to CJK substring queries; queries shorter than 3
  characters automatically fall back to LIKE.
- Scope: session titles + all user/assistant message text; results include a context snippet.

## Architecture

```
src/
├── core/
│   ├── db.ts          # SQLite schema (sessions/messages/sessions_fts) + queries
│   ├── sync.ts        # incremental sync (raw_size/mtime fingerprints skip unchanged files)
│   ├── watcher.ts     # chokidar watches local session dirs → debounce → incremental import
│   ├── import.ts      # cloud export import orchestration + inbox auto-processing
│   ├── export.ts      # Markdown export
│   └── sources/       # one adapter per source (3 local + 4 cloud)
├── api/server.ts      # Fastify (JSON API + static frontend)
├── cli/index.ts       # commander CLI
└── web/               # Vite + React frontend (two-pane: list + detail; tool calls & thinking collapsed)
tests/                 # vitest: adapter parsing / sync engine / importers / watcher integration / API
```

## Tests

```bash
pnpm test              # 44 cases
pnpm test:coverage     # coverage (core logic ~80%; the web frontend is verified manually in a browser, not unit-tested)
```

Coverage: message extraction and noise filtering for the three local adapters (synthetic JSONL
fixtures), incremental-sync fingerprint skipping and full rebuild, all cloud import formats
(including ChatGPT edited branches and Grok multi-format), inbox auto-processing and file moving,
watcher real-filesystem integration, all Fastify routes (including trigram search and the short-query
LIKE fallback), Markdown export format.

## Phase 2 (not implemented)

- `shiyi enrich`: LLM-generated session summaries/tags (`sessions.summary` / `sessions.tags` columns reserved)
- More local sources: ZCode (`~/.zcode`), OpenCode (sqlite), Cursor (sqlite)
- X bookmarks; automated cloud-session scraping

## Known limits

- Very large ChatGPT conversations.json (>1GB) needs memory; set `NODE_OPTIONS=--max-old-space-size=8192` if needed
- Images inside Codex sessions are kept as placeholder text (base64 never enters message bodies)
