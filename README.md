# pi-remote

A mobile remote for the [pi coding agent](https://shittycodingagent.ai).  
Kick off a task on your laptop, walk away, and monitor + steer it from Safari on your iPhone.

```
iPhone (Safari) ──── WebSocket ──── bridge.ts (Bun) ──── pi --mode rpc ──── agent
                   (Tailscale VPN)
```

## How it works

`bridge.ts` spawns `pi --mode rpc` as a child process and communicates with it over
JSONL stdin/stdout using pi's RPC protocol. It serves the web UI over HTTP and
multiplexes the pi RPC stream across all connected WebSocket clients.

- **pi events** (no `id` field) are broadcast to every connected client.
- **RPC responses** (with `id`) are routed back to the client that made the request.
- **Extension UI dialogs** (`extension_ui_request`) are broadcast; the first client
  to respond wins and the answer is forwarded to pi.

When you connect (or reconnect) the bridge bootstraps your client by fetching
`get_state`, `get_messages`, `get_commands`, and `get_available_models` from pi so
your UI is always up to date.

Model and thinking-level preferences are persisted to `prefs.json` and restored
automatically each time pi starts.

## Quick start

### 1. Install Tailscale

Install [Tailscale](https://tailscale.com/download) on both your laptop and iPhone.  
Note your laptop's Tailscale IP from the menu-bar icon (e.g. `100.x.y.z`).

### 2. Install dependencies

```bash
cd ~/repos/pi-remote
bun install
```

### 3. Run the bridge

```bash
# Run the agent in the current directory
bun run bridge.ts

# Or point it at a specific project
AGENT_CWD=~/repos/monorepo bun run bridge.ts

# Custom port (default: 7700)
PORT=8080 bun run bridge.ts
```

The bridge will:
- Spawn `pi --mode rpc` with its working directory set to `AGENT_CWD`
- Print pi events to the terminal as they arrive
- Serve the phone UI at `http://0.0.0.0:<PORT>`
- Exit automatically when the pi process exits

### 4. Open on your phone

```
http://<tailscale-ip>:7700
```

## Terminal usage

You can type messages directly in the terminal — no need to open the web UI when you're at your laptop.

| Input | Behaviour |
|-------|-----------|
| `some text` + Enter | Prompt with steer behaviour (works whether agent is idle or running) |
| `> some text` + Enter | Follow-up — sent as `follow_up`, queued until the agent finishes |
| `abort` + Enter | Abort the current operation |

## Phone UI features

| Feature | Notes |
|---------|-------|
| Live streaming text | Streamed via `message_update` events from pi |
| Markdown rendering | Full support: headings, lists, code blocks, tables, blockquotes |
| Tool activity | Shows current tool name + latest output |
| Send modes | **Prompt**, **Steer**, **Follow-up** |
| Abort button | Stops the current operation |
| Conversation history | Bootstrapped from pi on connect / reconnect |
| Auto-reconnect | Exponential back-off — survives brief network blips |
| **File reference autocomplete** | Type `@` to fuzzy-search & autocomplete project files (like TUI) |
| Extension UI dialogs | `extension_ui_request` round-trips: first client to respond wins; auto-deny on timeout |
| Model picker | Lists available models; recently-used models are persisted in `prefs.json` |
| Thinking level | Persisted across restarts |
| PWA / installable | Includes `manifest.json` and service worker for home-screen install |
| iOS Safari polish | No auto-zoom on input focus; safe-area padding for notch/home bar |

## WebSocket protocol

The bridge speaks the **pi RPC protocol** over WebSocket — messages are the same JSONL
objects that pi emits and accepts, forwarded with minimal translation.

### Bridge-only messages (not part of pi RPC)

#### Server → client

```jsonc
// Sent immediately on connect with persisted recent-model history
{ "type": "prefs", "recentModels": [{ "id": "...", "name": "...", "provider": "..." }] }
```

#### Client → server

```jsonc
// List session files for the current AGENT_CWD (handled bridge-side, not forwarded to pi)
{ "type": "list_sessions", "id": "some-id" }
// Response:
{ "type": "response", "command": "list_sessions", "success": true, "id": "some-id",
  "data": { "sessions": [{ "path": "...", "name": "first user message…", "mtime": 1234567890 }] } }
```

### Selected pi RPC events (server → client, broadcast)

```jsonc
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "Hello " } }
{ "type": "tool_execution_start", ... }
{ "type": "tool_execution_update", ... }
{ "type": "tool_execution_end", ... }
{ "type": "agent_start" }
{ "type": "agent_end" }
{ "type": "extension_ui_request", "id": "uuid", ... }
```

### Selected pi RPC commands (client → server, forwarded to pi)

```jsonc
{ "type": "prompt",              "id": "...", "message": "Refactor the auth hook", "streamingBehavior": "steer" }
{ "type": "steer",               "id": "...", "message": "Focus on the tests first" }
{ "type": "follow_up",           "id": "...", "message": "After that, run yarn type-check" }
{ "type": "abort",               "id": "..." }
{ "type": "set_model",           "id": "...", "provider": "anthropic", "modelId": "claude-opus-4-5" }
{ "type": "set_thinking_level",  "id": "...", "level": "medium" }
{ "type": "get_state",           "id": "..." }
{ "type": "get_messages",        "id": "..." }
{ "type": "get_commands",        "id": "..." }
{ "type": "get_available_models","id": "..." }
{ "type": "extension_ui_response", "id": "uuid", ... }
```

See the pi RPC documentation for the full protocol reference.

## File structure

```
pi-remote/
├── bridge.ts                        # Bun server: spawns pi --mode rpc, WebSocket bridge, file listing
├── prefs.json                       # Persisted model + thinking-level preferences (auto-created)
├── public/
│   ├── index.html                   # Phone UI shell
│   ├── style.css                    # Dark mobile-first styles + markdown + autocomplete styles
│   ├── client.js                    # WebSocket client, event rendering, autocomplete logic
│   ├── manifest.json                # PWA manifest for home-screen install
│   ├── sw.js                        # Service worker
│   └── icon.svg                     # App icon
├── package.json
├── PROJECT_PLAN.md                  # Architecture notes and roadmap
├── AUTOCOMPLETE.md                  # File reference autocomplete feature guide
├── IMPLEMENTATION_SUMMARY.md        # Technical implementation details
├── AUTOCOMPLETE_QUICK_REF.md        # Quick reference for developers
└── README.md
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `pi` CLI (`@mariozechner/pi-coding-agent`) | Spawned as `pi --mode rpc`; bridge communicates via JSONL stdin/stdout |
| [marked](https://marked.js.org/) (CDN) | Markdown rendering in the phone UI |
| [Tailscale](https://tailscale.com) | Secure tunnel from phone to laptop |

## File reference autocomplete

Type `@` in the message input to fuzzy-search project files:

```
Type:   "Fix the bug in @src"
Shows:  src/main.ts, src/index.ts, src/utils/...
Select: @src/main.ts (with ↑↓ arrow keys or mouse)
```

Features:
- **Fuzzy matching** - Type partial paths, matches expand (e.g., `@s/m` → `src/main.ts`)
- **Smart ignore** - Excludes `node_modules`, `.git`, `dist`, build directories
- **Keyboard navigation** - ↑↓ to select, Enter/Tab to insert, Escape to dismiss
- **Cached** - 5-second TTL prevents excessive filesystem scans
- **Mobile-friendly** - Popup positioned above input, touch-optimized

See [AUTOCOMPLETE.md](AUTOCOMPLETE.md) for full documentation and [AUTOCOMPLETE_QUICK_REF.md](AUTOCOMPLETE_QUICK_REF.md) for developer reference.

## References

- Pi RPC docs: `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Tailscale: https://tailscale.com
- File autocomplete guide: [AUTOCOMPLETE.md](AUTOCOMPLETE.md)
- Implementation details: [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md)
