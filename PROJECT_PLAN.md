# pi-remote Project Plan (Current)

## Status

The project is in the **RPC bridge architecture** state (v2 direction completed for core functionality).

`bridge.ts` currently:

- runs `pi --mode rpc` as a subprocess
- forwards RPC JSONL between pi and WebSocket clients
- bootstraps new clients with state/history/commands/models
- supports extension UI request/response routing
- serves the mobile web client
- provides bridge-side file/session listing helpers
- supports optional Web Push notifications

## Product goal

Provide a reliable, mobile-first remote control surface for a running pi agent session, with enough capability that users can meaningfully continue work away from their desk.

## Architecture

```
Browser (phone/laptop)
  ↕ WebSocket
bridge.ts (Bun)
  ↕ stdin/stdout JSONL
pi --mode rpc
```

### Design constraints

- pi owns agent/session logic
- bridge is protocol + transport glue
- client can reconnect and rebuild state from RPC
- multi-client behavior should stay coherent (broadcast events, route responses)

## Implemented scope

### Bridge

- [x] Spawn pi in RPC mode
- [x] Parse JSONL stream using newline split (without Node readline for stdout)
- [x] Route responses by request `id`
- [x] Broadcast events to all clients
- [x] Bootstrap new clients (`get_state`, `get_messages`, `get_commands`, `get_available_models`)
- [x] Forward/guard extension UI responses (first response wins)
- [x] Persist/restore model + thinking preferences
- [x] `list_files` (autocomplete) bridge command
- [x] `list_sessions` bridge command
- [x] Static file serving for `public/`
- [x] Graceful shutdown hooks

### UI

- [x] streaming conversation rendering
- [x] markdown rendering for completed assistant output
- [x] tool activity cards
- [x] thinking blocks
- [x] slash command picker
- [x] send mode controls + abort
- [x] file `@` autocomplete
- [x] session list + switch + new session
- [x] fork flow
- [x] export flow
- [x] compact button
- [x] thinking level controls
- [x] image attachment support
- [x] code block copy buttons
- [x] haptic + unread finish indicator
- [x] push-notification toggle plumbing

## Next priorities

1. **Protocol hardening**
   - explicit validation of inbound WS command shape
   - stronger error reporting around malformed or unknown commands

2. **Security / safety**
   - optional auth token for WebSocket/API endpoints
   - optional allowed-origin / subnet checks

3. **Operational quality**
   - lightweight health/status endpoint with pi child-process state
   - better diagnostics around push subscription lifecycle

4. **UX polish**
   - richer session metadata in list views
   - fork/search ergonomics for very long histories
   - optional configurable autocomplete ignore rules

## Non-goals

- Re-implementing agent behavior in bridge
- Replacing pi TUI for desktop power usage
- Maintaining a separate session state store in bridge
