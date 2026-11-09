English · [Español](README.es.md)

# Gentle UI

<p>
  <a href="https://github.com/Gentleman-Programming/gentle-shell"><img alt="Made with Gentle AI" src="https://img.shields.io/badge/Made%20with-Gentle%20AI-6A4BFF"></a>
  <img alt="Tauri v2" src="https://img.shields.io/badge/shell-Tauri%20v2-24C8DB">
  <img alt="Node >= 22" src="https://img.shields.io/badge/node-%3E%3D22-5FA04E">
  <img alt="pnpm 12" src="https://img.shields.io/badge/pnpm-12-4B5563">
  <img alt="Linux, macOS, Windows" src="https://img.shields.io/badge/platforms-linux%20%7C%20macOS%20%7C%20windows-6E6E6E">
</p>

Gentle UI is a desktop UI for [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell): a
cross-platform window over the Pi agent harness. It runs the same agent, against the same sessions and
the same configuration, and draws the app in a native window instead of a terminal.

## Why

The terminal UI is package code, and over RPC the pieces it is built from are explicitly unsupported:
`ctx.ui.custom()` returns `undefined`, and the header, footer and editor setters are no-ops. A fork
would inherit the whole delivery stack and still be limited to what a terminal can draw. So this
repository is a presentation layer, not a fork.

- **One harness, two windows.** The app spawns the real `pi --mode rpc` child process with Gentle
  Shell's own environment, so threads written here land where the terminal lists them, profiles are the
  same file, and the agent's tools and skills are the ones already installed.
- **Feature parity where the transport allows it.** Everything that is transport-independent is in the
  UI. Commands that only exist as terminal overlays are refused at one choke point with the surface
  that does the job instead, and elevated permission modes name the terminal command that sets them
  rather than pretending to work.
- **Updatable without a fork.** The harness is consumed as pinned packages, so an upstream release
  arrives as a version bump. No vendored copy of Gentle Shell lives in this tree.
- **Built for the mouse and the keyboard.** Agent and profile choices live in the composer and in
  panels, not in modals, and every action is also a palette entry and a chord.

## What you get

### Chat surface

- Streaming answers with Markdown rendering.
- The model's thinking chain, collapsed by default, clearly separated from the answer and replayed
  when a thread is reopened.
- Collapsible tool cards. Calls that touch files render a file-change card with the path, a
  `+N −M` count and either the unified diff or a preview, instead of the raw argument dump.
- Permission and questionnaire dialogs from extensions as inline cards in the transcript.
- History paged backwards out of the session file as you scroll, with tool results folded into the
  turn that called them; the stream follows only while you are at the end, and a jump-to-end control
  appears when you are not.
- A line that always says what the run is doing — thinking, running a tool, writing the answer,
  waiting for your approval — instead of a spinner that disappears.
- Prompts sent mid-run are queued, the draft survives a missing bridge, and a lost connection is
  visible with a Reconnect.

### Composer chips

Everything that changes how the next message runs is a chip in the composer, never a modal:

- **Model** — the agent's own model list, searchable.
- **Profile** — the profiles gentle-pi keeps, the active one marked `default`, plus *Manage profiles…*.
- **Permissions** — the mode new threads start in. The open thread keeps the mode it started with,
  because Pi publishes no per-thread mode over RPC. Only the terminal-free modes (`normal`, `auto`)
  are writable here; the elevated ones show the `/gentle:mode default …` line that sets them in a
  terminal.
- **Attachments** — drop files or paste a clipboard image; each row shows its name, size and whether
  the bridge accepted it.

### Inspector

The right panel, with drag-resizable splitters and tabs contextual to the selection:

- **Changes** — git status of the workspace with status glyphs and `+n −n` per file, and a unified
  diff classified into meta, hunk, context, add and remove.
- **Files** — the workspace tree, directories first, with a bounded preview.
- **Tasks** — the `odd/tasks/*.md` documents with their checkbox counts.
- **Agents** — the subagent runs of the open thread, newest first; a click opens a modal with that
  run's own steps and closes on Escape.
- **Review** — the first phase of native review: the authority on record with its frozen correction
  budget, the target, the risk assessment and the consent card that starts it.
- **Memory** — a read-only view over the Engram memory provider.
- **Settings** — a sheet from the rail footer and `Mod+,` with the session facts; model, profile and
  permission mode stay live in the composer.

### Keyboard

`Mod` is ⌘ on macOS and Ctrl elsewhere. `Mod K` palette (actions, threads, slash commands, models),
`Mod P` quick open a thread, `Mod B` rail, `Mod Alt B` inspector, `Mod Enter` send, `Esc` interrupt or
close, `Mod Shift K` cheat sheet, `Mod ,` settings.

### Profiles and permissions

- **Profiles** — a sheet that lists the profiles in gentle-pi's own `profiles.json` with each agent's
  model, thinking level and tier, and lets you duplicate, rename, delete and *Use for new threads*.
  Writes are atomic, and the file is backed up whenever it is not what the bridge last wrote. A
  running thread freezes its profile at start, so a change applies to the next thread.
- **Permission default** — the chip writes the mode new threads start in, and the menu always says
  which mode is current.

## How it works

```
┌──────────────────────────┐   WebSocket 127.0.0.1 + token   ┌────────────────────────┐
│ apps/desktop             │ ──────────────────────────────▶ │ packages/bridge        │
│ Tauri v2 shell           │ ◀────────────────────────────── │ Node process           │
│ Solid + Vite frontend    │        JSON messages            │ owns the agent child   │
└──────────────────────────┘                                 └───────────┬────────────┘
                                                                         │ JSONL over stdio
                                                                         ▼
                                                              pi --mode rpc
                                                       (agent, tools, sessions)
```

- **Tauri shell** (`apps/desktop/src-tauri`) — the native window, the system webview and, in a
  packaged build, spawning the bundled bridge and reading the port and token it prints.
- **Solid frontend** (`apps/desktop/src`) — the whole UI: transcript, composer, inspector, palette. In
  development it also runs in a plain browser against the dev bridge.
- **Node bridge** (`packages/bridge`) — spawns `pi --mode rpc` with Gentle Shell's pinned environment,
  frames the JSONL protocol, enforces the command allowlist, fans events out to the UI and re-answers
  extension dialogs.
- **Shared wire types** (`packages/protocol`) — the request and event shapes both sides compile
  against.

The rule that keeps this maintainable: the harness is consumed, never forked.
`@earendil-works/pi-coding-agent` is a pinned npm dependency, and `gentle-pi` is resolved from the
installed package at startup with the launcher environment pinned in place (`GENTLE_PI_PACKAGE`
overrides the package root). `pi --mode rpc` alone is not Gentle Shell; the bridge reproduces exactly
what the launcher injects, and `docs/architecture.md` explains why.

## Getting started

Requirements: **Node >= 22** and **pnpm 12** (the repository pins `pnpm@12.4.1` in `package.json`). A
Rust toolchain and the Linux webkit dependencies are only needed for the Tauri window.

```bash
pnpm install        # every workspace package
pnpm dev            # bridge on :7787 and the UI on http://localhost:1420
pnpm dev:desktop    # the Tauri window (the first build compiles the Rust shell)
pnpm test           # every package: desktop and bridge
pnpm typecheck      # every workspace package
```

Open http://localhost:1420 while developing the interface. `pnpm dev:web` and `pnpm dev:bridge` run
those two halves separately.

Two notes so nothing surprises you: the bridge suite starts a real `pi --mode rpc` child and loads the
gentle-pi harness, so it needs both installed on the machine, and building installers needs a
platform-specific build (see `docs/packaging.md`).

## Repository layout

```
apps/desktop        Tauri v2 shell + Solid UI (runs in a browser during development)
packages/bridge     Node process that owns `pi --mode rpc` and speaks WebSocket to the UI
packages/protocol   Shared wire types
docs/               Architecture and packaging notes
odd/tasks/          Feature documents with specs, tasks and evidence
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — the design: shell, bridge, protocol, commands, panels,
  packaging in brief.
- [docs/packaging.md](docs/packaging.md) — how a release is produced: sidecar, bundle layout, CI,
  release workflow.
- [README.es.md](README.es.md) — this document in Spanish.
- Spanish mirrors: [docs/architecture.es.md](docs/architecture.es.md),
  [docs/packaging.es.md](docs/packaging.es.md).

## Built on Gentle Shell

[Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell) is the harness this UI drives:
the agent, its tools, its commands, its profiles and its session format all come from there. This
repository only adds a window. Because nothing is forked, an upstream release is picked up by moving
to its version: `@earendil-works/pi-coding-agent` is pinned in `packages/bridge/package.json`, and
`gentle-pi` is the installed package the bridge resolves at startup. There is no vendored source and
no patched copy to rebase.

## Status

Working, and honest about what is not finished. As of `develop` on 2026-11-08:

- 29 of the 32 tasks in `odd/tasks/gentle-shell-desktop-ui.md` are checked. Open: the second phase of
  native review (lens captures, verdicts and acknowledgement), the profiles bridge module's
  verification gate, and packaging.
- **Tests:** 163 desktop and 216 bridge tests green, both suites running together.
- **Packaging is not shipped yet.** The sidecar script, the CI checks and the release workflow exist,
  but no installer has been produced and launched from this tree, so the packaged paths are covered by
  code review, not by a run.
- **Terminal-only surface stays terminal-only.** Some gentle-pi commands need `ctx.ui.custom()`, which
  RPC cannot provide, and the composer chip refuses the elevated permission modes with the command
  that sets them.
