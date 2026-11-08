# gentle shell ui

A desktop workspace for the Gentle Shell / Pi agent harness. The harness is consumed as a pinned
dependency; this repository is only the surface.

```
apps/desktop      Tauri v2 shell + Solid UI (runs in a browser during development)
packages/bridge   Node process that owns `pi --mode rpc` and speaks WebSocket to the UI
packages/protocol Shared wire types
docs/             Architecture and protocol notes
odd/tasks/        Feature document with specs, tasks and evidence
```

## Run it

```bash
pnpm install
pnpm dev            # bridge on :7787 and the UI on http://localhost:1420
```

Open http://localhost:1420 while developing the interface. The Tauri window is only needed for native
features (file dialogs, drag and drop, notifications):

```bash
pnpm dev:desktop    # first build compiles the Rust shell
```

## Checks

```bash
pnpm test           # every package: desktop and bridge (the bridge needs the real pi binary)
pnpm typecheck      # every workspace package
```

## How it talks to the agent

One `pi --mode rpc` child process per thread, strict JSONL framing, command allowlist, and extension
dialogs surfaced as inline permission cards. Details in [docs/architecture.md](docs/architecture.md).
