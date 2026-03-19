# Implementation Summary

This document reflects the **current** state of pi-remote.

## Core architecture

- Runtime: Bun
- Bridge entrypoint: `bridge.ts`
- Agent integration: child process `pi --mode rpc`
- Transport: WebSocket between browser and bridge, JSONL stdin/stdout between bridge and pi

## Bridge behavior

- Spawns pi and exits when pi exits
- Parses stdout/stderr streams and forwards relevant payloads to connected clients
- Broadcasts pi events to all clients
- Routes RPC responses by request id to the originating client
- Supports bridge-initiated RPC bootstrap requests for newly connected clients

### Bootstrap flow on client connect

The bridge sends:

1. `get_state`
2. `get_messages`
3. `get_commands`
4. `get_available_models`

and locally sends:

- `prefs` (recent models)
- `session_info` (folder + branch)

### Persistence

- `prefs.json`
  - last model
  - recent models
  - last thinking level
- `push-prefs.json`
  - VAPID keys
  - push subscriptions

## Bridge-side custom commands

Handled without forwarding to pi:

- `list_files`
- `list_sessions`

## UI capabilities (public/client.js)

- conversation rendering with incremental streaming updates
- markdown rendering for finalized assistant text
- tool execution cards
- thinking block rendering and toggle
- slash command picker from `get_commands`
- mode-aware sending (`prompt`, `steer`, `follow_up`) + abort
- file autocomplete (`@`) with fuzzy score
- session list/switch/new session
- fork selection flow
- compact trigger
- model selection + recent model chips
- thinking level controls
- export conversation HTML
- image attachments
- code block copy buttons
- unread/finish indicator + haptics
- push notification subscribe/unsubscribe client flow

## Push notifications

Implemented via `web-push` in bridge:

- VAPID key management
- subscription storage
- send notifications on `agent_end`
- prune invalid/stale subscriptions on known failure statuses

HTTP endpoints:

- `GET /api/push/public-key`
- `POST /api/push/subscribe`
- `POST /api/push/unsubscribe`
- `POST /api/push/test`
- `GET /api/push/status`

## Known gaps

- No built-in auth on bridge endpoints
- No automated test suite in this repo yet
- Some command input validation remains permissive
