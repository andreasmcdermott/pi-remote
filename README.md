# pi-remote

A mobile remote for the [pi coding agent](https://shittycodingagent.ai).  
Kick off a task on your laptop, walk away, and monitor + steer it from Safari on your iPhone.

```
iPhone (Safari) ──── WebSocket ──── bridge.ts (Bun) ──── pi SDK ──── agent
                   (Tailscale VPN)
```

## How it works

`bridge.ts` **is** the agent runner — you launch it instead of running `pi` directly.
It starts a pi agent session via the SDK, serves the web UI over HTTP, and bridges agent
events to any connected phone clients over WebSocket. There is no separate pi process;
the bridge owns the session for its entire lifetime.

When you're at your laptop you follow progress via terminal output. When you're away, you
open the phone UI and pick up from wherever the agent is.

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
- Resume the most recent pi session for `AGENT_CWD` (or start a new one)
- Print agent output to the terminal as it runs
- Serve the phone UI at `http://0.0.0.0:<PORT>`

### 4. Open on your phone

```
http://<tailscale-ip>:7700
```

## Terminal output

While the agent runs you'll see a compact log in the terminal:

```
[user] refactor the auth hook

I'll start by reading the current implementation.

[tool: read] ......... ✓

Here's my plan: ...

[tool: bash] .... ✓

Done. The hook has been refactored into three smaller functions.
```

Streaming assistant text is printed inline. Tool executions show a dot per update and a
✓/✗ at the end. Steered and follow-up messages are labelled `[steer]` / `[follow_up]`.

## Phone UI features

| Feature | Notes |
|---------|-------|
| Live streaming text | Plain text while in-flight, rendered to markdown on completion |
| Markdown rendering | Full support: headings, lists, code blocks, tables, blockquotes |
| Tool activity banner | Shows current tool name + last line of output |
| Send modes | **Prompt** (new task), **Steer** (interrupt), **Follow-up** (queue for after) |
| Abort button | Stops the current operation |
| Conversation history | Full history replayed on connect / reconnect |
| Auto-reconnect | Exponential back-off up to 15 s — survives brief network blips |
| Confirm dialogs | safe-bash extension round-trips: Allow / Deny with auto-deny on timeout |
| iOS Safari polish | No auto-zoom on input focus; safe-area padding for notch/home bar |

## WebSocket protocol

### Server → phone

```jsonc
{ "type": "text_delta",          "delta": "Hello " }
{ "type": "tool_start",          "toolName": "bash", "args": { "command": "yarn build" } }
{ "type": "tool_update",         "toolName": "bash", "output": "partial output..." }
{ "type": "tool_end",            "toolName": "bash", "isError": false }
{ "type": "agent_start" }
{ "type": "agent_end" }
{ "type": "auto_compaction_start" }
{ "type": "auto_compaction_end" }
{ "type": "auto_retry_start",    "attempt": 2 }
{ "type": "auto_retry_end" }
{ "type": "confirm_request",     "id": "uuid", "title": "Dangerous command", "message": "Allow rm -rf?", "timeout": 30000 }
{ "type": "history",             "messages": [ { "role": "user", "content": "..." }, ... ] }
{ "type": "error",               "message": "..." }
```

### Phone → server

```jsonc
{ "type": "prompt",           "text": "Refactor the auth hook" }
{ "type": "steer",            "text": "Focus on the tests first" }
{ "type": "follow_up",        "text": "After that, run yarn type-check" }
{ "type": "abort" }
{ "type": "confirm_response", "id": "uuid", "confirmed": true }
```

## File structure

```
pi-remote/
├── bridge.ts          # Bun server: pi SDK + WebSocket bridge + terminal logging
├── public/
│   ├── index.html     # Phone UI shell
│   ├── style.css      # Dark mobile-first styles + markdown rendering styles
│   └── client.js      # WebSocket client, event rendering, marked.js integration
├── package.json
├── PROJECT_PLAN.md    # Architecture notes and roadmap
└── README.md
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | pi SDK — agent session, events, tools |
| [marked](https://marked.js.org/) (CDN) | Markdown rendering in the phone UI |
| [Tailscale](https://tailscale.com) | Secure tunnel from phone to laptop |

## References

- Pi SDK docs: `~/.bun/install/global/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Tailscale: https://tailscale.com
