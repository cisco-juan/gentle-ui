# Architecture

## Shape

```
 ┌─────────────────────────┐        WebSocket (127.0.0.1, token)        ┌──────────────────┐
 │ apps/desktop            │  ────────────────────────────────────────▶ │ packages/bridge  │
 │ Tauri v2 + Solid viewer │  ◀──────────────────────────────────────── │ Node child of pi │
 └─────────────────────────┘        JSON messages + raw records        └──────────────────┘
                                                                                  │ JSONL
                                                                                  ▼
                                                                        pi --mode rpc
                                                                     (agent, tools, sessions)
```

The desktop shell renders; the bridge owns processes and protocol; Pi owns the agent. No part of
Gentle Shell is forked: `@earendil-works/pi-coding-agent` and `gentle-pi` are pinned dependencies, so
upstream releases arrive as version bumps.

## Why not fork the TUI

Gentle Shell's terminal UI is package code that reaches into Pi's private layout internals
(`tui.layoutRoot` plus a symbol-keyed layout node) to build its rail, and it depends on
`setFooter`/`setHeader`/`setEditorComponent` and `ctx.ui.custom()`. Over RPC those are explicitly
unsupported: `custom()` returns `undefined` and the footer/header/editor setters are no-ops. A fork
would inherit the whole delivery stack (launcher, postinstall binary downloads, generated
`runtime/*.mjs`, version guards) and still be limited to what a terminal can draw.

## The protocol we speak

`pi --mode rpc` is JSONL over stdin/stdout, LF-framed. Node's `readline` is not usable: it splits on
`U+2028`/`U+2029`, which are legal inside JSON strings.

- **Commands** (`stdin`, one record with optional `id`): `prompt`, `steer`, `follow_up`, `abort`,
  `clear_queue`, `new_session`, `get_state`, `get_messages`, `set_model`, `cycle_model`,
  `get_available_models`, thinking levels, `compact`, `bash`, `abort_bash`, `get_session_stats`,
  `export_html`, `switch_session`, `fork`, `clone`, `get_tree`, `get_entries`, `set_session_name`,
  `get_commands`. The allowlist lives in `packages/bridge/src/commands.ts`.
- **Responses**: `{"type":"response","id","command","success","data"|"error"}`.
- **Events**: `agent_start`, `turn_*`, `message_start|update|end` (delta streaming via
  `contentIndex`), `tool_execution_start|update|end`, `queue_update`, `compaction_*`,
  `auto_retry_*`, `agent_settled`, `extension_error`, `bash_execution_update`.
- **Dialogs**: `extension_ui_request` with `method` of `select`, `confirm`, `input` or `editor`
  blocks the agent until we answer `{"type":"extension_ui_response","id","value"|"confirmed"|"cancelled"}`.
  These are the permission prompts and questionnaires; the UI renders them as inline cards.
- **Fire-and-forget**: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.

`agent_end` ends one low-level run; `agent_settled` is the only signal that Pi will not continue
automatically (retries, compaction, steering and follow-ups can follow). The UI stays in "running"
until settled.

## What the UI gets free and what it rebuilds

Free from RPC and the session files: threads (`get_tree`, `switch_session`, `fork`, `clone`),
transcript (`get_messages` plus streaming events), tool activity, permissions, model and thinking
level selection, commands and skills (`get_commands`), stats, compaction, bash, subagent activity
(published by gentle-pi as structured `setWidget` payloads), memory (external provider).

Rebuilt by us: every panel (rail, inspector, palette, cheat sheet), the composer, the diff view, the
task list, and the review surface. Those were TUI components; nothing about them is transport.

## Distribution of functionality

1. **Left rail** (collapsible): Sessions, Git, Files, Tasks, Memory, Agents, Settings; below it the
   project → thread tree with inline search.
2. **Chat centre**: messages, collapsible tool cards, inline diffs, permission cards.
3. **Right inspector**: the same views as tabs, contextual to the selection.
4. **Composer**: profile, model, effort, permission mode and attachments as inline chips — no modals.
5. **Palette** (`Mod K`): every action and slash command by name.

Keybindings use `Mod` (⌘ on macOS, Ctrl elsewhere). Baseline: `Mod K` palette, `Mod P` quick open,
`Mod B` rail, `Mod Alt B` inspector, `Mod Enter` send, `Esc` interrupt, `Mod Shift K` cheat sheet.

## Packaging

Tauri compiles per operating system; artefacts come from a CI matrix (Linux `.AppImage`/`.deb`,
macOS `.dmg`, Windows `.msi`), never from cross-compilation. The webview is the system one
(webkit2gtk on Linux, WKWebView on macOS, WebView2 on Windows), so keep CSS to what all three honour.
Node ships as a Tauri sidecar so users never install Node or Pi. Code signing is a distribution
decision, not a build one.
