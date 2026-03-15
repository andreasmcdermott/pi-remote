# TODO

## Probably most missed

- [x] **Image/screenshot attachment** — paste or attach a screenshot directly into the chat input; send as image content to the agent
- [x] **Code block copy button** — rendered markdown code blocks should have a one-tap copy button (especially important on mobile)
- [x] **Session switching** — list saved sessions and switch between them; start a new session from the UI
- [x] **Conversation forking** — UI for pi's `fork` RPC; pick an earlier message and branch from there

## Moderately useful

- [x] **Thinking level control** — slider or segmented control to adjust reasoning depth for models that support it (`set_thinking_level`)
- [x] **Manual compact button** — trigger compaction when context gets long, without waiting for auto-compaction
- [x] **Running token/cost display** — show a live counter during streaming, not just after agent finishes
- [x] **Export / share** — save or export a conversation (trigger `export_html` or similar)

## Polish

- [x] **PWA / add to home screen** — add a web app manifest and service worker so it installs as a proper icon on iOS
- [x] **Haptic feedback on mobile** — subtle vibration when agent starts and finishes (navigator.vibrate)
- [x] **Unread / finish indicator** — badge or notification when the agent finishes a run while you're not looking at the screen
