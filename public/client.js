/**
 * pi-remote client
 *
 * Manages the WebSocket connection to bridge.ts, renders events into the
 * conversation view, and sends commands back to the server.
 */

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusDot    = document.getElementById("status-dot");
const statusText   = document.getElementById("status-text");
const abortBtn     = document.getElementById("abort-btn");
const conversation = document.getElementById("conversation");
const toolBanner   = document.getElementById("tool-banner");
const toolNameEl   = document.getElementById("tool-name");
const toolOutputEl = document.getElementById("tool-output");
const confirmOverlay = document.getElementById("confirm-overlay");
const confirmTitle   = document.getElementById("confirm-title");
const confirmMsg     = document.getElementById("confirm-message");
const confirmAllow   = document.getElementById("confirm-allow");
const confirmDeny    = document.getElementById("confirm-deny");
const msgInput     = document.getElementById("msg-input");
const sendBtn      = document.getElementById("send-btn");

// ─── marked configuration ────────────────────────────────────────────────────

marked.setOptions({ breaks: true });   // single newline → <br> inside paragraphs

// ─── State ───────────────────────────────────────────────────────────────────

let ws = null;
let isConnected = false;
let isAgentRunning = false;
let currentAssistantBubble = null; // bubble being streamed into
let currentAssistantRaw = "";      // accumulated raw markdown for current bubble
let reconnectDelay = 1000;
let pendingConfirmId = null;

// ─── Connection ──────────────────────────────────────────────────────────────

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    isConnected = true;
    reconnectDelay = 1000;
    setConnectionStatus("connected");
  });

  ws.addEventListener("close", () => {
    isConnected = false;
    ws = null;
    setConnectionStatus("disconnected");
    // Reconnect with back-off
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  });

  ws.addEventListener("error", () => {
    // close event will follow; nothing extra needed
  });

  ws.addEventListener("message", (evt) => {
    let event;
    try { event = JSON.parse(evt.data); } catch { return; }
    handleEvent(event);
  });
}

// ─── Event handling ──────────────────────────────────────────────────────────

function handleEvent(event) {
  switch (event.type) {

    case "history":
      renderHistory(event.messages);
      break;

    case "agent_start":
      isAgentRunning = true;
      setAgentStatus("running");
      break;

    case "agent_end":
      isAgentRunning = false;
      setAgentStatus("idle");
      finaliseAssistantBubble();
      hideTool();
      break;

    case "text_delta":
      appendAssistantDelta(event.delta);
      break;

    case "tool_start":
      showTool(event.toolName, JSON.stringify(event.args ?? {}));
      break;

    case "tool_update":
      updateTool(event.output);
      break;

    case "tool_end":
      if (event.isError) {
        updateTool("(error)");
      }
      break;

    case "auto_compaction_start":
      appendSystemNote("⟳ Compacting context…");
      break;

    case "auto_compaction_end":
      appendSystemNote("✓ Compaction complete");
      break;

    case "auto_retry_start":
      appendSystemNote(`↺ Retrying (attempt ${event.attempt})…`);
      break;

    case "auto_retry_end":
      break;

    case "confirm_request":
      showConfirm(event.id, event.title, event.message, event.timeout);
      break;

    case "error":
      appendErrorBubble(event.message);
      break;
  }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

function renderHistory(messages) {
  conversation.innerHTML = "";
  currentAssistantBubble = null;
  currentAssistantRaw = "";
  for (const msg of messages) {
    if (msg.role === "user") {
      appendUserBubble(msg.content);
    } else {
      const row = createBubbleRow("assistant");
      const b = createBubble("assistant");
      b.innerHTML = marked.parse(msg.content);
      row.appendChild(b);
      conversation.appendChild(row);
    }
  }
  scrollToBottom();
}

/** Wraps a bubble in a .bubble-row with a sender label. */
function createBubbleRow(role) {
  const row = document.createElement("div");
  row.className = `bubble-row ${role}`;
  const label = document.createElement("div");
  label.className = "sender-label";
  label.textContent = role === "user" ? "You" : "pi";
  row.appendChild(label);
  return row;
}

function createBubble(cls) {
  const div = document.createElement("div");
  div.className = `bubble ${cls}`;
  return div;
}

function appendUserBubble(text) {
  const row = createBubbleRow("user");
  const b = createBubble("user");
  b.textContent = text;
  row.appendChild(b);
  conversation.appendChild(row);
  scrollToBottom();
}

function appendAssistantDelta(delta) {
  if (!currentAssistantBubble) {
    const row = createBubbleRow("assistant");
    currentAssistantBubble = createBubble("assistant streaming");
    row.appendChild(currentAssistantBubble);
    conversation.appendChild(row);
    currentAssistantRaw = "";
  }
  currentAssistantRaw += delta;
  // While streaming, render as plain text for speed (no mid-stream markdown flicker)
  currentAssistantBubble.textContent = currentAssistantRaw;
  scrollToBottom();
}

function finaliseAssistantBubble() {
  if (currentAssistantBubble) {
    // Swap plain text for rendered markdown now that the response is complete
    currentAssistantBubble.innerHTML = marked.parse(currentAssistantRaw);
    currentAssistantBubble.classList.remove("streaming");
    currentAssistantBubble = null;
    currentAssistantRaw = "";
  }
}

function appendSystemNote(text) {
  const b = createBubble("system-note");
  b.textContent = text;
  conversation.appendChild(b);
  scrollToBottom();
}

function appendErrorBubble(text) {
  const b = createBubble("error-msg");
  b.textContent = `⚠ ${text}`;
  conversation.appendChild(b);
  scrollToBottom();
}

function scrollToBottom() {
  // requestAnimationFrame ensures layout has updated before scrolling
  requestAnimationFrame(() => {
    conversation.scrollTop = conversation.scrollHeight;
  });
}

// ─── Tool banner ─────────────────────────────────────────────────────────────

function showTool(name, output) {
  toolNameEl.textContent = `▶ ${name}`;
  toolOutputEl.textContent = output ?? "";
  toolBanner.classList.remove("hidden");
}

function updateTool(output) {
  // Show only the last line for compactness
  const lines = (output ?? "").trim().split("\n");
  toolOutputEl.textContent = lines[lines.length - 1] ?? "";
}

function hideTool() {
  toolBanner.classList.add("hidden");
  toolNameEl.textContent = "";
  toolOutputEl.textContent = "";
}

// ─── Status indicators ───────────────────────────────────────────────────────

function setConnectionStatus(state) {
  if (state === "connected") {
    // Don't override agent status when we reconnect
    if (!isAgentRunning) setAgentStatus("idle");
    updateSendButton();
  } else {
    statusDot.className = "dot error";
    statusText.textContent = "reconnecting…";
    sendBtn.disabled = true;
    abortBtn.disabled = true;
  }
}

function setAgentStatus(state) {
  if (state === "running") {
    statusDot.className = "dot running";
    statusText.textContent = "running";
    abortBtn.disabled = false;
  } else {
    statusDot.className = "dot idle";
    statusText.textContent = "idle";
    abortBtn.disabled = true;
  }
  updateSendButton();
}

function updateSendButton() {
  sendBtn.disabled = !isConnected || msgInput.value.trim().length === 0;
}

// ─── Confirm dialog ──────────────────────────────────────────────────────────

let confirmTimeout = null;

function showConfirm(id, title, message, timeout) {
  pendingConfirmId = id;
  confirmTitle.textContent = title;
  confirmMsg.textContent = message;
  confirmOverlay.classList.remove("hidden");

  // Auto-deny on timeout
  if (confirmTimeout) clearTimeout(confirmTimeout);
  confirmTimeout = setTimeout(() => {
    if (pendingConfirmId === id) respondConfirm(false);
  }, timeout);
}

function respondConfirm(confirmed) {
  if (!pendingConfirmId) return;
  send({ type: "confirm_response", id: pendingConfirmId, confirmed });
  pendingConfirmId = null;
  confirmOverlay.classList.add("hidden");
  if (confirmTimeout) { clearTimeout(confirmTimeout); confirmTimeout = null; }
}

confirmAllow.addEventListener("click", () => respondConfirm(true));
confirmDeny.addEventListener("click",  () => respondConfirm(false));

// ─── Sending messages ────────────────────────────────────────────────────────

function getMode() {
  return document.querySelector('input[name="send-mode"]:checked')?.value ?? "prompt";
}

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !isConnected) return;

  const mode = getMode();

  // Optimistic user bubble (only for prompt; steer/follow_up are instructions)
  if (mode === "prompt") {
    appendUserBubble(text);
  } else {
    appendSystemNote(`[${mode}] ${text}`);
  }

  send({ type: mode, text });

  msgInput.value = "";
  msgInput.style.height = "auto";
  updateSendButton();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ─── Input interactions ───────────────────────────────────────────────────────

sendBtn.addEventListener("click", sendMessage);

msgInput.addEventListener("keydown", (e) => {
  // Send on Enter (without Shift) on non-mobile
  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 600) {
    e.preventDefault();
    sendMessage();
  }
});

msgInput.addEventListener("input", () => {
  // Auto-grow textarea
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + "px";
  updateSendButton();
});

abortBtn.addEventListener("click", () => {
  send({ type: "abort" });
});

// ─── Boot ────────────────────────────────────────────────────────────────────

connect();
