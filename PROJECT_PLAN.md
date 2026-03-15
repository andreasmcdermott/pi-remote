# pi-remote

A mobile remote for the [pi coding agent](https://shittycodingagent.ai) that lets you monitor
and control a running agent session from your iPhone — kick off a task, go for lunch, then
check progress and send the next prompt directly from your phone.

---

## Architecture

```
iPhone browser ──── WebSocket ──── Bun server (on laptop) ──── pi SDK
                  (Tailscale VPN)       bridge.ts              agent running
                                                               in ~/repos/monorepo
```

Three pieces:

1. **Bridge server** — a Bun script using the pi SDK that runs the agent and exposes a
   WebSocket server. It is the agent runner; you launch it instead of `pi`.
2. **Web UI** — a simple page served by the same server; the phone opens it in Safari
3. **Tailscale** — provides a secure tunnel from the phone to the laptop without exposing
   anything to the internet

No app. No App Store. Just a browser.

---

## pi SDK integration

The pi SDK (`@mariozechner/pi-coding-agent`) provides `createAgentSession()` which gives
access to the full agent lifecycle. The bridge subscribes to session events and forwards
them to WebSocket clients, and also logs them to the terminal.

### Events forwarded to the phone

| Event | Use |
|-------|-----|
| `text_delta` | Stream assistant response word by word |
| `tool_execution_start/update/end` | Show current tool and its output |
| `agent_start` / `agent_end` | Idle vs. running state |
| `auto_compaction_start/end` | Background compaction activity |
| `auto_retry_start/end` | Retry after transient error |

### Terminal logging

In addition to forwarding events over WebSocket, the bridge prints a compact log to stdout:
- Streaming assistant text is written inline via `process.stdout.write`
- Tool executions: `[tool: <name>]` + a dot per `tool_execution_update` + `✓`/`✗` on end
- User commands labelled: `[user]`, `[steer]`, `[follow_up]`

### Commands from the phone to the agent

| Method | Use |
|--------|-----|
| `session.prompt(text)` | Kick off a new task |
| `session.steer(text)` | Interrupt mid-run with new instructions |
| `session.followUp(text)` | Queue a message for when the agent finishes |
| `session.abort()` | Stop the current operation |

### Extension UI (confirm dialogs)

The existing `safe-bash` extension fires confirm dialogs before dangerous commands
(`rm -rf`, `git reset --hard`, etc.). In RPC/SDK mode these come through as
`extension_ui_request` events with `method: "confirm"`. The bridge:

1. Forwards the request to the phone UI
2. Waits for the user's response
3. Returns an `extension_ui_response` to the agent via the event's `respond` callback

If the phone doesn't respond within the request's `timeout`, the agent auto-resolves
with the default (deny).

---

## WebSocket protocol (bridge ↔ phone)

A thin JSON protocol over WebSocket. The bridge forwards SDK events and the phone sends
commands.

### Server → phone (events)

```jsonc
// Streaming text
{ "type": "text_delta", "delta": "Hello " }

// Tool activity
{ "type": "tool_start", "toolName": "bash", "args": { "command": "yarn type-check" } }
{ "type": "tool_update", "toolName": "bash", "output": "partial output..." }
{ "type": "tool_end", "toolName": "bash", "isError": false }

// Agent lifecycle
{ "type": "agent_start" }
{ "type": "agent_end" }

// Confirm dialog from safe-bash extension
{ "type": "confirm_request", "id": "uuid", "title": "Dangerous command", "message": "Allow rm -rf?", "timeout": 30000 }

// Conversation history (sent on connect)
{ "type": "history", "messages": [ { "role": "user", "content": "..." }, ... ] }
```

### Phone → server (commands)

```jsonc
{ "type": "prompt",           "text": "Refactor the auth hook" }
{ "type": "steer",            "text": "Actually, focus on the tests first" }
{ "type": "follow_up",        "text": "After that, run yarn type-check" }
{ "type": "abort" }
{ "type": "confirm_response", "id": "uuid", "confirmed": true }
```

---

## Scope breakdown

### v1 — Working remote ✅

- [x] Bridge server (`bridge.ts`) using pi SDK
- [x] WebSocket server on a fixed port (default 7700, override with `PORT=`)
- [x] Forward `text_delta`, `tool_*`, `agent_start/end` events
- [x] Accept `prompt`, `steer`, `follow_up`, `abort` commands from phone
- [x] Terminal logging (streaming text + tool activity + labelled commands)
- [x] Confirm dialog support (safe-bash extension round-trip)
- [x] Conversation history on connect (renders past messages)
- [x] Auto-reconnect (phone loses WiFi briefly)
- [x] Markdown rendering for assistant responses (marked.js, rendered on completion)
- [x] iOS Safari polish: no auto-zoom on input focus; safe-area insets
- [x] Serve the web UI from the bridge server
- [x] Minimal phone web UI:
  - Streaming text display (plain text while in-flight, markdown on completion)
  - Tool activity banner ("▶ bash · last line of output")
  - Send mode selector: Prompt / Steer / Follow-up
  - Text input + Send button
  - Abort button

### v2 — Nice to have

- [ ] Session status in the page title (idle / running / tool name)
- [ ] git-checkpoint notifications
- [ ] `/tree` branch navigation (simplified list view)
- [ ] Model switcher
- [ ] Multiple session support (pick from session list)
- [ ] PWA manifest (add to home screen, offline shell)

---

## Tech stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Bridge runtime | Bun | Fast startup, built-in WebSocket server |
| WebSocket server | `Bun.serve()` with WebSocket support | Built-in, no extra deps |
| Phone UI | Vanilla HTML/CSS/JS | No build step |
| Markdown | marked.js (CDN) | Lightweight, no build step |
| Tunnel | Tailscale | Free, peer-to-peer, no port forwarding needed |
| Pi integration | `@mariozechner/pi-coding-agent` SDK | Type-safe, same process |

---

## File structure

```
pi-remote/
├── PROJECT_PLAN.md       # This file
├── README.md
├── package.json
├── bridge.ts             # Main entry: pi SDK + WebSocket server + terminal logging
└── public/
    ├── index.html        # Phone web UI shell
    ├── style.css         # Dark mobile-first styles + markdown rendering
    └── client.js         # WebSocket client, event rendering, marked.js integration
```

---

## Getting started

1. **Install Tailscale** on laptop and iPhone — https://tailscale.com/download
2. **Note your laptop's Tailscale IP** — visible in the Tailscale menu bar icon
3. **Install dependencies**:
   ```bash
   cd ~/repos/pi-remote
   bun install
   ```
4. **Run the bridge**:
   ```bash
   AGENT_CWD=~/repos/monorepo bun run bridge.ts
   ```
5. **Open the phone UI** — navigate to `http://<tailscale-ip>:7700` in Safari

---

## References

- Pi SDK docs: `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Pi RPC docs: `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- Pi SDK examples: `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/examples/sdk/`
- Tailscale: https://tailscale.com
