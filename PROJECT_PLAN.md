# pi-remote

A mobile remote for the [pi coding agent](https://shittycodingagent.ai) that lets you monitor
and control a running agent session from your iPhone — kick off a task, go for lunch, then
check progress and send the next prompt directly from your phone.

---

## Goal

The primary use case is **mobile remote control**: use your phone to interact with the pi agent
running on your laptop while you're away from your desk. The phone UI should be genuinely
capable — not just a basic send/abort button — supporting slash commands, tool output visibility,
session management, and other features comparable to the desktop TUI.

A secondary benefit is that the same web UI works in a laptop browser too, but the native pi
TUI is **not** a goal for the laptop side — users who want the full TUI can just run `pi`
directly in a separate terminal.

---

## Architecture (v2 direction)

### The key architectural decision

**v1** used the pi SDK (`createAgentSession()`) to own the agent session directly inside
`bridge.ts`. This approach has a fundamental limitation: the bridge *is* the agent, so you
cannot simultaneously use the native pi TUI on your laptop for the same session.

**v2** switches to wrapping `pi --mode rpc`. The bridge spawns pi as a child process and
communicates with it over stdin/stdout using pi's JSON-RPC protocol. The bridge's only job
is to multiplex that RPC stream across multiple WebSocket clients (laptop browser + phone).

```
Phone Safari ──┐
               ├── WebSocket ── bridge.ts (Bun) ── stdin/stdout JSONL ── pi --mode rpc
Laptop browser─┘
               (Tailscale VPN)
```

### Why RPC mode instead of the SDK

- **Full pi feature parity**: extensions, skills, `/` commands, session management, model
  switching, compaction, auto-retry — all handled natively by pi, not reimplemented in the bridge
- **`get_commands` RPC call** returns all available slash commands (extension commands, prompt
  templates, skills), enabling a proper `/` command picker in the mobile UI
- **Simpler bridge**: the bridge doesn't need to understand the agent at all — it just routes
  JSONL between pi and WebSocket clients, handling fan-out to multiple clients
- **pi handles session persistence**: no SDK session management code needed in the bridge
- **Extension UI protocol**: confirm dialogs, notifications, etc. all work via the RPC
  extension UI sub-protocol

### Why not keep the SDK approach

The SDK is the right choice when you need direct programmatic control of the agent in the same
Node.js process. For a remote UI bridge, RPC mode is cleaner — the bridge is just a protocol
adapter, not an agent runner.

---

## RPC protocol summary

Pi's RPC mode is a JSONL protocol over stdin/stdout. Key details:

- **Split records on `\n` only** (not `\r\n` or Unicode line separators — Node `readline` is not compliant)
- Commands sent to pi's stdin; events and responses stream from pi's stdout
- Commands have an optional `id` field; responses include the same `id`
- Events (streamed output) do NOT have an `id` field

### Key RPC commands the bridge needs to support

| Command | Purpose |
|---------|---------|
| `prompt` | Send user message (supports `streamingBehavior: "steer"\|"followUp"` when streaming) |
| `steer` | Interrupt agent mid-run |
| `follow_up` | Queue message for when agent finishes |
| `abort` | Stop current operation |
| `get_state` | Current model, streaming status, session info |
| `get_messages` | Full conversation history |
| `get_commands` | All available `/` commands (extensions + templates + skills) |
| `set_model` | Switch model |
| `cycle_model` | Cycle to next model |
| `get_available_models` | List models with API keys |
| `compact` | Manual compaction |
| `set_auto_compaction` | Toggle auto-compaction |
| `new_session` | Start fresh session |
| `switch_session` | Load a different session file |
| `fork` | Fork from a previous message |
| `get_fork_messages` | List messages available to fork from |
| `get_session_stats` | Token usage and cost |
| `bash` | Execute shell command and inject into context |
| `set_thinking_level` | Set reasoning depth |

### Key RPC events the bridge forwards to WebSocket clients

| Event | Purpose |
|-------|---------|
| `message_update` | Streaming text/thinking/toolcall deltas |
| `tool_execution_start/update/end` | Tool activity |
| `agent_start` / `agent_end` | Agent lifecycle |
| `auto_compaction_start/end` | Compaction activity |
| `auto_retry_start/end` | Retry after transient error |
| `extension_ui_request` | Confirm dialogs, notifications, etc. |

### Extension UI protocol

When extensions call `ctx.ui.confirm()`, `ctx.ui.select()`, etc., pi emits an
`extension_ui_request` event. Dialog methods (`confirm`, `select`, `input`, `editor`) block
until the client sends back an `extension_ui_response` with a matching `id`. The bridge must:

1. Forward `extension_ui_request` events to all WebSocket clients
2. Accept `extension_ui_response` commands from whichever client responds
3. Forward the response back to pi's stdin
4. Handle timeouts (pi auto-resolves after the `timeout` field elapses — bridge doesn't need to track this)

---

## Bridge design (v2)

The bridge is a thin multiplexer. It does NOT interpret the agent protocol — it just routes.

### Responsibilities

1. **Spawn pi**: `pi --mode rpc` (or `pi --mode rpc --session-dir <path>`)
2. **Read pi stdout**: parse JSONL lines, fan-out to all connected WebSocket clients
3. **Accept WebSocket connections**: on connect, send current state via `get_state` and
   `get_messages` RPC calls so new clients can catch up
4. **Accept WebSocket messages from clients**: validate JSON, forward to pi stdin as JSONL
5. **Serve the web UI**: static files from `public/`
6. **Terminal passthrough** (optional): allow typing commands in the terminal the bridge
   is running in, for quick testing without opening the browser

### What the bridge does NOT do

- Parse or understand agent messages
- Maintain its own conversation state (pi owns that)
- Implement any agent logic
- Handle session persistence

### Multi-client considerations

- All events from pi are broadcast to all connected clients
- Commands from any client are forwarded to pi (last writer wins — no locking)
- On connect: fetch state and history via RPC and send to the new client
- Extension UI dialog requests: forward to all clients; first response wins and is forwarded to pi

---

## Mobile UI design (v2)

The web UI should be a capable mobile-first interface. Target: feature parity with the
essential parts of the pi TUI, optimised for thumb use on an iPhone.

### Core features (must have for v2)

- **Chat thread**: streaming assistant text (plain text while streaming, markdown on completion)
- **Tool activity**: collapsible tool cards showing tool name, args, and output
- **Send modes**: Prompt / Steer / Follow-up (selector or gesture)
- **Slash command picker**: `/` triggers a searchable list populated from `get_commands`
- **Abort button**: visible whenever agent is streaming
- **Confirm dialogs**: modal for `extension_ui_request` confirm/select/input
- **Session info**: model name, token count / cost (from `get_session_stats`)
- **Auto-reconnect**: handles brief network drops

### Nice-to-have (v2 stretch / v3)

- **Model switcher**: dropdown populated from `get_available_models`
- **Thinking level control**: for reasoning models
- **Fork / branch navigation**: simplified list of past prompts to fork from
- **Session list**: switch between saved sessions
- **PWA manifest**: add to home screen
- **Image attachment**: send images to the agent
- **Session export**: trigger `export_html`

---

## Scope breakdown

### v1 — SDK-based bridge ✅ (complete, superseded by v2)

- [x] Bridge server (`bridge.ts`) using pi SDK
- [x] WebSocket server on a fixed port (default 7700, override with `PORT=`)
- [x] Forward `text_delta`, `tool_*`, `agent_start/end` events
- [x] Accept `prompt`, `steer`, `follow_up`, `abort` commands from phone
- [x] Terminal logging (streaming text + tool activity + labelled commands)
- [x] Terminal input loop (type to prompt/steer/follow-up/abort without opening the web UI)
- [x] Confirm dialog support (safe-bash extension round-trip)
- [x] Conversation history on connect (renders past messages)
- [x] Auto-reconnect
- [x] Markdown rendering for assistant responses
- [x] iOS Safari polish
- [x] Serve the web UI from the bridge server

### v2 — RPC-based bridge + capable mobile UI 🚧

#### Bridge rewrite
- [ ] Replace SDK session with `pi --mode rpc` child process
- [ ] JSONL reader on pi stdout (split on `\n` only — do NOT use Node readline)
- [ ] Fan-out all pi events to all connected WebSocket clients
- [ ] Forward WebSocket commands from clients to pi stdin
- [ ] On new WebSocket connection: call `get_state` + `get_messages` and send to client
- [ ] Extension UI protocol: forward `extension_ui_request` to all clients; first
      `extension_ui_response` wins and is forwarded to pi stdin
- [ ] Graceful shutdown: close pi process on bridge exit

#### Mobile UI upgrades
- [ ] Slash command picker: `/` in the input opens a searchable list from `get_commands`
- [ ] Richer tool cards: collapsible, show args and streaming output
- [ ] Session status bar: model name, streaming indicator, token/cost from `get_session_stats`
- [ ] Thinking/reasoning output: collapsible thinking blocks
- [ ] Confirm dialog modal (replace current basic implementation)
- [ ] Send mode UX improvements (clearer steer vs. follow-up affordance)

---

## Tech stack

| Layer | Choice | Reason |
|-------|--------|--------|
| Bridge runtime | Bun | Fast startup, built-in WebSocket server, built-in `spawn` |
| WebSocket server | `Bun.serve()` with WebSocket support | Built-in, no extra deps |
| Phone UI | Vanilla HTML/CSS/JS | No build step |
| Markdown | marked.js (CDN) | Lightweight, no build step |
| Tunnel | Tailscale | Free, peer-to-peer, no port forwarding needed |
| Pi integration | `pi --mode rpc` subprocess | Full feature parity, no SDK coupling |

---

## File structure

```
pi-remote/
├── PROJECT_PLAN.md       # This file
├── README.md
├── package.json
├── bridge.ts             # Main entry: spawn pi --mode rpc + WebSocket multiplexer
└── public/
    ├── index.html        # Web UI shell (mobile-first)
    ├── style.css         # Dark mobile-first styles + markdown rendering
    └── client.js         # WebSocket client, event rendering, slash command picker
```

---

## Getting started (v1, current)

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

- Pi RPC docs: `node_modules/@mariozechner/pi-coding-agent/docs/rpc.md` (also in this repo)
- Pi SDK docs: `node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Pi extensions docs: `node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Pi SDK examples: `node_modules/@mariozechner/pi-coding-agent/examples/sdk/`
- Tailscale: https://tailscale.com
