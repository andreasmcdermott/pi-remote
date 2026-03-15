# pi-remote

A mobile remote for the [pi coding agent](https://shittycodingagent.ai).  
Kick off a task on your laptop, walk away, and monitor + steer it from Safari on your iPhone.

```
iPhone (Safari) ──── WebSocket ──── bridge.ts (Bun) ──── pi SDK ──── agent
                   (Tailscale VPN)
```

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
```

The server starts on port 7700 by default.  
Override with `PORT=8080 bun run bridge.ts`.

### 4. Open on your phone

Navigate to:

```
http://<tailscale-ip>:7700
```

## Features (v1)

| Feature | Status |
|---------|--------|
| Stream assistant text live | ✅ |
| Tool activity banner (running: bash) | ✅ |
| Send prompt / steer / follow-up | ✅ |
| Abort button | ✅ |
| Conversation history on reconnect | ✅ |
| Auto-reconnect on network blip | ✅ |
| safe-bash confirm dialogs | ✅ |
| Mobile-optimised UI (iOS Safari) | ✅ |

## WebSocket protocol

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full server↔phone JSON protocol.

## File structure

```
pi-remote/
├── bridge.ts          # Bun server: pi SDK + WebSocket bridge
├── public/
│   ├── index.html     # Phone UI shell
│   ├── style.css      # Dark mobile-first styles
│   └── client.js      # WebSocket client + event rendering
├── package.json
└── README.md
```
