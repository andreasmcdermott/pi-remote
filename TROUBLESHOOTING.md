# Troubleshooting

## 1) UI doesn’t load or looks stale

- Hard refresh the page
- Clear site data/cache for the bridge origin
- Confirm bridge is running and reachable (`http://<host>:<port>`)

Bridge startup should show lines like:

```text
[bridge] Web Push ready (...)
[bridge] Spawning pi --mode rpc, cwd=...
[bridge] Listening on http://0.0.0.0:7700
```

## 2) WebSocket won’t connect

- Check Tailscale connectivity between phone and laptop
- Verify port (`PORT`, default `7700`)
- Confirm no firewall rule is blocking the port
- Watch bridge logs for connect/disconnect lines

## 3) Messages send but no agent response

- Inspect bridge logs for `bridge_error` or pi stderr output
- Ensure `pi` is installed and runnable on host
- Check model/provider credentials in your pi setup

## 4) Autocomplete issues (`@...`)

If files do not appear:

- Ensure bridge `AGENT_CWD` points at expected project
- Force refresh file list in console:

```js
sendWithId({ type: "list_files", forceRefresh: true })
```

- Check ignore lists in `bridge.ts` (`IGNORED_DIRS`, `IGNORED_FILES`)

If ranking feels wrong:

- Review scoring logic in `fileMatchScore()` (`public/client.js`)

## 5) Session list/switch issues

- Session listing uses bridge-side filesystem scan of `~/.pi/agent/sessions/...`
- Confirm sessions exist for the current `AGENT_CWD`
- Confirm process has permission to read that directory

## 6) Push notifications not working

Requirements:

- Browser supports Notifications + Service Worker + PushManager
- Notification permission is granted
- Client subscribed successfully (`/api/push/subscribe`)

Checks:

- `GET /api/push/status` should show subscription count > 0
- Use `POST /api/push/test` to test delivery
- Verify tab/client activity rules: active clients are skipped on done-notify

## 7) Extension dialog stuck

- `extension_ui_request` is broadcast to all clients
- first matching `extension_ui_response` wins
- if no response, pi resolves per its own timeout behavior

## Useful debugging info to share

- Browser console errors
- First ~50 lines of bridge logs after startup
- Exact reproduction steps
- Device/browser details
- Whether issue reproduces with a desktop browser on same network
