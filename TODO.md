# TODO

## Probably most missed

- [ ] **Image/screenshot attachment** — paste or attach a screenshot directly into the chat input; send as image content to the agent
- [ ] **Code block copy button** — rendered markdown code blocks should have a one-tap copy button (especially important on mobile)
- [ ] **Session switching** — list saved sessions and switch between them; start a new session from the UI
- [ ] **Conversation forking** — UI for pi's `fork` RPC; pick an earlier message and branch from there

## Moderately useful

- [ ] **Thinking level control** — slider or segmented control to adjust reasoning depth for models that support it (`set_thinking_level`)
- [ ] **Manual compact button** — trigger compaction when context gets long, without waiting for auto-compaction
- [ ] **Running token/cost display** — show a live counter during streaming, not just after agent finishes
- [ ] **Export / share** — save or export a conversation (trigger `export_html` or similar)

## Polish

- [ ] **PWA / add to home screen** — add a web app manifest and service worker so it installs as a proper icon on iOS
- [ ] **Haptic feedback on mobile** — subtle vibration when agent starts and finishes (navigator.vibrate)
- [ ] **Unread / finish indicator** — badge or notification when the agent finishes a run while you're not looking at the screen
