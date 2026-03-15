/**
 * pi-remote client (v2 — RPC mode)
 *
 * Speaks the pi RPC protocol directly via the bridge WebSocket.
 * Receives raw RPC events and responses from pi (forwarded by bridge).
 * Sends RPC commands to pi (forwarded by bridge).
 */

// ─── marked config ───────────────────────────────────────────────────────────
marked.setOptions({ breaks: true });

// ─── DOM refs ────────────────────────────────────────────────────────────────
const statusDot      = document.getElementById("status-dot");
const statusText     = document.getElementById("status-text");
const modelBtn       = document.getElementById("model-btn");
const modelPanel     = document.getElementById("model-panel");
const modelList      = document.getElementById("model-list");
const sessionStats   = document.getElementById("session-stats");
const abortBtn       = document.getElementById("abort-btn");
const conversation   = document.getElementById("conversation");
const cmdPicker      = document.getElementById("cmd-picker");
const cmdList        = document.getElementById("cmd-list");
const dialogOverlay  = document.getElementById("dialog-overlay");
const dialogBox      = document.getElementById("dialog-box");
const dialogTitle    = document.getElementById("dialog-title");
const dialogMessage  = document.getElementById("dialog-message");
const dialogOptions  = document.getElementById("dialog-options");
const dialogInput    = document.getElementById("dialog-input");
const dialogEditor   = document.getElementById("dialog-editor");
const dialogButtons  = document.getElementById("dialog-buttons");
const dialogCancel   = document.getElementById("dialog-cancel");
const dialogConfirm  = document.getElementById("dialog-confirm");
const msgInput       = document.getElementById("msg-input");
const sendBtn        = document.getElementById("send-btn");

// ─── State ───────────────────────────────────────────────────────────────────
let ws               = null;
let isConnected      = false;
let isStreaming      = false;
let reconnectDelay   = 1000;
let reqCounter       = 0;

// Slash commands list (populated from get_commands response)
let availableCommands = [];

// All available models (populated from get_available_models response)
let allAvailableModels = [];

// Recent models (pushed from bridge via prefs message)
let recentModels = [];

// Currently active model
let activeModel = null;

// Whether the dropdown is showing all models or just recents
let modelPanelShowingAll = false;

// Whether the dropdown panel is open
let modelPanelOpen = false;

// Keyboard-focused index within the panel (-1 = none)
let modelPanelFocusIdx = -1;

// Current active dialog
let activeDialog = null; // { id, method, resolve }

// Streaming render state
let streamingTurn = null; // { textEl, thinkingEl, thinkingRaw, textRaw, toolCards: Map<toolCallId, el> }

// ─── WebSocket ───────────────────────────────────────────────────────────────

function nextId() { return `client-${++reqCounter}`; }

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener("open", () => {
    isConnected = true;
    reconnectDelay = 1000;
    setConnectionStatus("connected");
  });

  ws.addEventListener("close", () => {
    isConnected = false;
    ws = null;
    setConnectionStatus("disconnected");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  });

  ws.addEventListener("error", () => { /* close follows */ });

  ws.addEventListener("message", (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleMessage(msg);
  });
}

function send(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(cmd));
  }
}

function sendWithId(cmd) {
  const id = nextId();
  send({ ...cmd, id });
  return id;
}

// ─── Main message dispatcher ─────────────────────────────────────────────────

function handleMessage(msg) {
  // RPC response (from bridge-initiated get_state/get_messages/get_commands,
  // or from commands we sent)
  if (msg.type === "response") {
    handleResponse(msg);
    return;
  }

  // Extension UI request (dialog or fire-and-forget)
  if (msg.type === "extension_ui_request") {
    handleExtensionUIRequest(msg);
    return;
  }

  // Commands mirrored from another connected client
  if (msg.type === "prompt" || msg.type === "steer" || msg.type === "follow_up") {
    handleMirroredCommand(msg);
    return;
  }

  // Model switch mirrored from another client — update our dropdown
  if (msg.type === "set_model") {
    if (msg.provider && msg.modelId) {
      const m = allAvailableModels.find(m => m.id === msg.modelId && m.provider === msg.provider);
      if (m) setSelectedModel(m);
    }
    return;
  }

  // Prefs pushed from bridge (recents, etc.)
  if (msg.type === "prefs") {
    recentModels = msg.recentModels ?? [];
    renderModelPanel();
    return;
  }

  // Agent events
  switch (msg.type) {
    case "agent_start":
      isStreaming = true;
      setAgentStatus("running");
      startStreamingTurn();
      break;

    case "agent_end":
      isStreaming = false;
      setAgentStatus("idle");
      finaliseStreamingTurn();
      // Refresh stats after agent finishes
      requestStats();
      break;

    case "message_update":
      handleMessageUpdate(msg);
      break;

    case "tool_execution_start":
      handleToolStart(msg);
      break;

    case "tool_execution_update":
      handleToolUpdate(msg);
      break;

    case "tool_execution_end":
      handleToolEnd(msg);
      break;

    case "auto_compaction_start":
      appendSystemNote("⟳ Compacting context…");
      break;

    case "auto_compaction_end":
      appendSystemNote("✓ Compaction complete");
      break;

    case "auto_retry_start":
      appendSystemNote(`↺ Retrying (attempt ${msg.attempt ?? 1})…`);
      break;

    case "auto_retry_end":
      if (msg.success === false) {
        appendErrorBubble(`Auto-retry failed: ${msg.finalError ?? "unknown error"}`);
      }
      break;

    case "extension_error":
      appendErrorBubble(`Extension error: ${msg.error}`);
      break;
  }
}

// ─── Mirrored commands from other clients ────────────────────────────────────

function handleMirroredCommand(cmd) {
  if (cmd.type === "prompt") {
    appendUserBubble(cmd.message ?? "");
  } else if (cmd.type === "steer") {
    appendSystemNote(`[steer] ${cmd.message ?? ""}`);
  } else if (cmd.type === "follow_up") {
    appendSystemNote(`[follow-up] ${cmd.message ?? ""}`);
  }
}

// ─── RPC response handler ────────────────────────────────────────────────────

function handleResponse(msg) {
  if (!msg.success) {
    // Only show errors for user-visible failures (not abort of nothing, etc.)
    if (msg.error && msg.command !== "abort") {
      appendErrorBubble(`Error (${msg.command}): ${msg.error}`);
    }
    return;
  }

  switch (msg.command) {
    case "get_state":
      applyState(msg.data);
      break;

    case "get_messages":
      renderHistory(msg.data.messages ?? []);
      break;

    case "get_commands":
      availableCommands = msg.data.commands ?? [];
      break;

    case "get_available_models":
      populateModelSelect(msg.data.models ?? []);
      break;

    case "set_model":
      if (msg.data) setSelectedModel(msg.data);
      break;

    case "get_session_stats":
      applyStats(msg.data);
      break;
  }
}

// ─── State & stats ───────────────────────────────────────────────────────────

function applyState(data) {
  if (!data) return;
  isStreaming = data.isStreaming ?? false;
  setAgentStatus(isStreaming ? "running" : "idle");
  if (data.model) setSelectedModel(data.model);
}

// Recent models are managed by the bridge and pushed via "prefs" messages.
// No localStorage needed — recents are shared across all clients.

// ─── Model dropdown ───────────────────────────────────────────────────────────

function populateModelSelect(models) {
  allAvailableModels = models;
  modelPanelShowingAll = false;
  modelBtn.disabled = models.length === 0;
  renderModelPanel();
}

function renderModelPanel() {
  const models = allAvailableModels;

  const recentAvailable = recentModels
    .map(r => models.find(m => m.id === r.id && m.provider === r.provider))
    .filter(Boolean);

  const recentIds = new Set(recentAvailable.map(m => `${m.provider}/${m.id}`));
  const remaining = models.filter(m => !recentIds.has(`${m.provider}/${m.id}`));

  modelList.innerHTML = "";

  function addGroupLabel(text) {
    const el = document.createElement("div");
    el.className = "model-group-label";
    el.textContent = text;
    modelList.appendChild(el);
  }

  function addModelBtn(m) {
    const btn = document.createElement("button");
    const isCurrent = activeModel?.id === m.id && activeModel?.provider === m.provider;
    btn.className = "model-option" + (isCurrent ? " active" : "");
    btn.textContent = m.name ?? m.id;
    btn.addEventListener("click", () => {
      sendWithId({ type: "set_model", provider: m.provider, modelId: m.id });
      closeModelPanel();
    });
    modelList.appendChild(btn);
  }

  if (recentAvailable.length > 0) {
    addGroupLabel("Recent");
    recentAvailable.forEach(addModelBtn);
  }

  if (modelPanelShowingAll || recentAvailable.length === 0) {
    if (remaining.length > 0) {
      if (recentAvailable.length > 0) addGroupLabel("All models");
      remaining.forEach(addModelBtn);
    }
  } else if (remaining.length > 0) {
    const showAll = document.createElement("button");
    showAll.className = "model-option model-show-all";
    showAll.textContent = `Show all (${models.length})…`;
    showAll.addEventListener("click", (e) => {
      e.stopPropagation(); // keep panel open
      modelPanelShowingAll = true;
      renderModelPanel();
    });
    modelList.appendChild(showAll);
  }
}

function setSelectedModel(model) {
  activeModel = model;
  modelBtn.textContent = model.name ?? model.id;
  if (modelPanelOpen) renderModelPanel(); // refresh active highlight if open
}

function openModelPanel() {
  if (modelBtn.disabled) return;
  modelPanelShowingAll = false;
  renderModelPanel();
  modelPanel.classList.remove("hidden");
  modelPanelOpen = true;
  modelPanelFocusIdx = -1;
  // Pre-focus the active model
  const btns = getModelPanelBtns();
  const activeIdx = btns.findIndex(b => b.classList.contains("active"));
  if (activeIdx !== -1) setModelPanelFocus(activeIdx);
}

function closeModelPanel() {
  modelPanel.classList.add("hidden");
  modelPanelOpen = false;
  modelPanelFocusIdx = -1;
}

function getModelPanelBtns() {
  return [...modelList.querySelectorAll("button.model-option")];
}

function setModelPanelFocus(idx) {
  const btns = getModelPanelBtns();
  btns.forEach(b => b.classList.remove("focused"));
  if (idx < 0 || idx >= btns.length) { modelPanelFocusIdx = -1; return; }
  modelPanelFocusIdx = idx;
  btns[idx].classList.add("focused");
  btns[idx].scrollIntoView({ block: "nearest" });
}

modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  modelPanelOpen ? closeModelPanel() : openModelPanel();
});

document.addEventListener("click", () => closeModelPanel());

function applyStats(data) {
  if (!data) return;
  const cost = data.cost != null ? `$${data.cost.toFixed(4)}` : "";
  const tokens = data.tokens?.total != null
    ? `${(data.tokens.total / 1000).toFixed(1)}k tokens`
    : "";
  sessionStats.textContent = [tokens, cost].filter(Boolean).join(" · ");
}

function requestStats() {
  send({ type: "get_session_stats", id: nextId() });
}

// ─── History rendering ───────────────────────────────────────────────────────

function renderHistory(messages) {
  conversation.innerHTML = "";
  streamingTurn = null;

  // We'll group: collect tool calls by toolCallId for matching with results
  const toolCallEls = new Map(); // toolCallId -> card element

  for (const msg of messages) {
    switch (msg.role) {
      case "user": {
        const text = extractUserText(msg.content);
        if (text) appendUserBubble(text);
        break;
      }

      case "assistant": {
        // Render all content blocks in one turn
        const turnEl = createTurnElement();
        let hasContent = false;

        for (const block of (msg.content ?? [])) {
          if (block.type === "text" && block.text) {
            const textEl = document.createElement("div");
            textEl.className = "bubble assistant";
            textEl.innerHTML = marked.parse(block.text);
            turnEl.appendChild(textEl);
            hasContent = true;
          } else if (block.type === "thinking" && block.thinking) {
            const thinkEl = createThinkingBlock(block.thinking, false);
            turnEl.appendChild(thinkEl);
            hasContent = true;
          } else if (block.type === "toolCall") {
            const card = createToolCard(block.name, block.arguments, null, false);
            card.dataset.toolCallId = block.id;
            toolCallEls.set(block.id, card);
            turnEl.appendChild(card);
            hasContent = true;
          }
        }

        if (hasContent) conversation.appendChild(turnEl);
        break;
      }

      case "toolResult": {
        // Attach result to the matching tool card if we have one
        const card = toolCallEls.get(msg.toolCallId);
        if (card) {
          const outputText = extractToolResultText(msg.content);
          populateToolCardOutput(card, outputText, msg.isError);
        }
        break;
      }

      case "bashExecution": {
        appendSystemNote(`$ ${msg.command}`);
        break;
      }
    }
  }

  scrollToBottom();
}

function extractUserText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
  }
  return "";
}

function extractToolResultText(content) {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter(c => c.type === "text").map(c => c.text).join("\n");
}

// ─── Streaming markdown renderer ─────────────────────────────────────────────

/**
 * Render as much markdown as we safely can during streaming.
 * Split on the last blank line: everything before it is a complete block and
 * safe to parse; the trailing in-progress block is shown as plain text so
 * partial tables/code fences etc. never render as broken markup.
 */
function renderStreamingMarkdown(raw) {
  const splitAt = raw.lastIndexOf("\n\n");
  const committed = splitAt === -1 ? "" : raw.slice(0, splitAt + 2);
  const renderedMd = committed ? marked.parse(committed) : "";
  return renderedMd + `<span class="streaming-spinner"></span>`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Streaming turn management ────────────────────────────────────────────────

function startStreamingTurn() {
  // Clear any previous in-progress turn
  finaliseStreamingTurn();
  streamingTurn = {
    turnEl: createTurnElement(),
    textEl: null,
    textRaw: "",
    thinkingEl: null,
    thinkingRaw: "",
    toolCards: new Map(), // toolCallId -> card el
  };
  conversation.appendChild(streamingTurn.turnEl);
}

function finaliseStreamingTurn() {
  if (!streamingTurn) return;
  const t = streamingTurn;

  // Finalise text: swap streaming plain text for rendered markdown
  if (t.textEl && t.textRaw) {
    t.textEl.innerHTML = marked.parse(t.textRaw);
    t.textEl.classList.remove("streaming");
  }

  // Finalise thinking
  if (t.thinkingEl && t.thinkingRaw) {
    const pre = t.thinkingEl.querySelector(".thinking-content");
    if (pre) {
      pre.textContent = t.thinkingRaw;
      t.thinkingEl.querySelector(".thinking-toggle")?.classList.remove("streaming");
    }
  }

  streamingTurn = null;
}

function handleMessageUpdate(msg) {
  const e = msg.assistantMessageEvent;
  if (!e || !streamingTurn) return;
  const t = streamingTurn;

  switch (e.type) {
    case "text_start":
      // Create or reuse text bubble
      if (!t.textEl) {
        t.textEl = document.createElement("div");
        t.textEl.className = "bubble assistant streaming";
        t.turnEl.appendChild(t.textEl);
      }
      break;

    case "text_delta":
      if (!t.textEl) {
        t.textEl = document.createElement("div");
        t.textEl.className = "bubble assistant streaming";
        t.turnEl.appendChild(t.textEl);
      }
      t.textRaw += e.delta;
      t.textEl.innerHTML = renderStreamingMarkdown(t.textRaw);
      scrollToBottom();
      break;

    case "text_end":
      // Will be finalised on agent_end
      break;

    case "thinking_start":
      if (!t.thinkingEl) {
        t.thinkingEl = createThinkingBlock("", true);
        t.turnEl.insertBefore(t.thinkingEl, t.textEl);
      }
      break;

    case "thinking_delta":
      if (!t.thinkingEl) {
        t.thinkingEl = createThinkingBlock("", true);
        if (t.textEl) t.turnEl.insertBefore(t.thinkingEl, t.textEl);
        else t.turnEl.appendChild(t.thinkingEl);
      }
      t.thinkingRaw += e.delta;
      const pre = t.thinkingEl.querySelector(".thinking-content");
      if (pre) pre.textContent = t.thinkingRaw;
      break;

    case "toolcall_start":
      // Tool call starting — name may arrive via toolcall_end; just create placeholder
      if (e.toolCall?.id) {
        const card = createToolCard(e.toolCall.name ?? "…", null, null, true);
        t.toolCards.set(e.toolCall.id, card);
        t.turnEl.appendChild(card);
      }
      break;

    case "toolcall_end":
      if (e.toolCall?.id && t.toolCards.has(e.toolCall.id)) {
        const card = t.toolCards.get(e.toolCall.id);
        updateToolCardName(card, e.toolCall.name);
        updateToolCardArgs(card, e.toolCall.arguments);
      }
      break;
  }
}

function handleToolStart(msg) {
  if (!streamingTurn) return;
  const card = streamingTurn.toolCards.get(msg.toolCallId);
  if (card) {
    card.classList.add("running");
    updateToolCardStatus(card, "running");
  }
}

function handleToolUpdate(msg) {
  if (!streamingTurn) return;
  const card = streamingTurn.toolCards.get(msg.toolCallId);
  if (card) {
    const text = extractToolResultText(msg.partialResult?.content ?? []);
    populateToolCardOutput(card, text, false);
    scrollToBottom();
  }
}

function handleToolEnd(msg) {
  if (!streamingTurn) return;
  const card = streamingTurn.toolCards.get(msg.toolCallId);
  if (card) {
    card.classList.remove("running");
    card.classList.toggle("error", msg.isError);
    updateToolCardStatus(card, msg.isError ? "error" : "done");
    const text = extractToolResultText(msg.result?.content ?? []);
    if (text) populateToolCardOutput(card, text, msg.isError);
    scrollToBottom();
  }
}

// ─── DOM helpers: turns, bubbles, tool cards, thinking ───────────────────────

function createTurnElement() {
  const el = document.createElement("div");
  el.className = "turn";
  return el;
}

function appendUserBubble(text) {
  const row = document.createElement("div");
  row.className = "bubble-row user";
  const label = document.createElement("div");
  label.className = "sender-label";
  label.textContent = "You";
  const b = document.createElement("div");
  b.className = "bubble user";
  b.textContent = text;
  row.appendChild(label);
  row.appendChild(b);
  conversation.appendChild(row);
  scrollToBottom();
}

function appendSystemNote(text) {
  const el = document.createElement("div");
  el.className = "bubble system-note";
  el.textContent = text;
  conversation.appendChild(el);
  scrollToBottom();
}

function appendErrorBubble(text) {
  const el = document.createElement("div");
  el.className = "bubble error-msg";
  el.textContent = `⚠ ${text}`;
  conversation.appendChild(el);
  scrollToBottom();
}

function createThinkingBlock(content, isStreaming) {
  const wrapper = document.createElement("div");
  wrapper.className = "thinking-block" + (isStreaming ? " streaming" : "");

  const toggle = document.createElement("button");
  toggle.className = "thinking-toggle" + (isStreaming ? " streaming" : "");
  toggle.textContent = "💭 Thinking…";
  toggle.setAttribute("aria-expanded", "false");

  const pre = document.createElement("pre");
  pre.className = "thinking-content hidden";
  pre.textContent = content;

  toggle.addEventListener("click", () => {
    const expanded = pre.classList.toggle("hidden");
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "💭 Thinking…" : "💭 Thinking (hide)";
  });

  wrapper.appendChild(toggle);
  wrapper.appendChild(pre);
  return wrapper;
}

function createToolCard(name, args, output, isRunning) {
  const card = document.createElement("div");
  card.className = "tool-card" + (isRunning ? " running" : "");

  const header = document.createElement("div");
  header.className = "tool-header";

  const nameEl = document.createElement("span");
  nameEl.className = "tool-name";
  nameEl.textContent = name ?? "…";

  const statusEl = document.createElement("span");
  statusEl.className = "tool-status";
  statusEl.textContent = isRunning ? "⟳" : output != null ? "✓" : "";

  const toggleEl = document.createElement("button");
  toggleEl.className = "tool-toggle";
  toggleEl.textContent = "▶";

  header.appendChild(nameEl);
  header.appendChild(statusEl);
  header.appendChild(toggleEl);

  const body = document.createElement("div");
  body.className = "tool-body hidden";

  if (args) {
    const argsEl = document.createElement("pre");
    argsEl.className = "tool-args";
    argsEl.textContent = typeof args === "string" ? args : JSON.stringify(args, null, 2);
    body.appendChild(argsEl);
  }

  if (output) {
    const outEl = document.createElement("pre");
    outEl.className = "tool-output";
    outEl.textContent = output;
    body.appendChild(outEl);
  }

  toggleEl.addEventListener("click", () => {
    const hidden = body.classList.toggle("hidden");
    toggleEl.textContent = hidden ? "▶" : "▼";
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function updateToolCardName(card, name) {
  const nameEl = card.querySelector(".tool-name");
  if (nameEl && name) nameEl.textContent = name;
}

function updateToolCardArgs(card, args) {
  const body = card.querySelector(".tool-body");
  if (!body || !args) return;
  let argsEl = body.querySelector(".tool-args");
  if (!argsEl) {
    argsEl = document.createElement("pre");
    argsEl.className = "tool-args";
    body.insertBefore(argsEl, body.firstChild);
  }
  argsEl.textContent = typeof args === "string" ? args : JSON.stringify(args, null, 2);
}

function updateToolCardStatus(card, status) {
  const statusEl = card.querySelector(".tool-status");
  if (!statusEl) return;
  statusEl.textContent = status === "running" ? "⟳" : status === "error" ? "✗" : "✓";
  statusEl.className = "tool-status " + status;
}

function populateToolCardOutput(card, text, isError) {
  const body = card.querySelector(".tool-body");
  if (!body) return;
  let outEl = body.querySelector(".tool-output");
  if (!outEl) {
    outEl = document.createElement("pre");
    outEl.className = "tool-output";
    body.appendChild(outEl);
  }
  outEl.textContent = text;
  if (isError) outEl.classList.add("error");
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    conversation.scrollTop = conversation.scrollHeight;
  });
}

// ─── Extension UI protocol ───────────────────────────────────────────────────

function handleExtensionUIRequest(req) {
  const { id, method } = req;

  // Fire-and-forget methods: no response expected
  if (method === "notify") {
    appendSystemNote(`[${req.notifyType ?? "info"}] ${req.message ?? ""}`);
    return;
  }
  if (method === "setStatus" || method === "setWidget" || method === "setTitle" || method === "set_editor_text") {
    // Could display in UI; for now just ignore
    return;
  }

  // Dialog methods: need a response
  if (activeDialog) {
    // Already showing a dialog; queue or drop. For simplicity, resolve current with cancel.
    resolveDialog(null, true);
  }

  showDialog(req);
}

function showDialog(req) {
  const { id, method, title, message, options, placeholder, prefill, timeout } = req;

  dialogTitle.textContent = title ?? method;

  // Show/hide message
  if (message) {
    dialogMessage.textContent = message;
    dialogMessage.classList.remove("hidden");
  } else {
    dialogMessage.classList.add("hidden");
  }

  // Reset all input areas
  dialogOptions.innerHTML = "";
  dialogOptions.classList.add("hidden");
  dialogInput.classList.add("hidden");
  dialogInput.value = "";
  dialogEditor.classList.add("hidden");
  dialogEditor.value = "";
  dialogConfirm.classList.add("hidden");

  if (method === "confirm") {
    dialogConfirm.textContent = "Allow";
    dialogConfirm.classList.remove("hidden");
    dialogCancel.textContent = "Deny";
  } else if (method === "select") {
    // Render option buttons
    dialogOptions.classList.remove("hidden");
    for (const opt of (options ?? [])) {
      const btn = document.createElement("button");
      btn.className = "btn-option";
      btn.textContent = opt;
      btn.addEventListener("click", () => resolveDialog(opt, false));
      dialogOptions.appendChild(btn);
    }
    dialogCancel.textContent = "Cancel";
  } else if (method === "input") {
    dialogInput.placeholder = placeholder ?? "";
    dialogInput.classList.remove("hidden");
    dialogConfirm.textContent = "OK";
    dialogConfirm.classList.remove("hidden");
    dialogCancel.textContent = "Cancel";
    setTimeout(() => dialogInput.focus(), 50);
  } else if (method === "editor") {
    dialogEditor.value = prefill ?? "";
    dialogEditor.classList.remove("hidden");
    dialogConfirm.textContent = "OK";
    dialogConfirm.classList.remove("hidden");
    dialogCancel.textContent = "Cancel";
    setTimeout(() => dialogEditor.focus(), 50);
  }

  activeDialog = { id, method };
  dialogOverlay.classList.remove("hidden");

  // Auto-resolve on timeout (if provided) — we just cancel visually but pi will auto-resolve
  // No need for us to track; pi handles it
}

function resolveDialog(value, cancelled) {
  if (!activeDialog) return;
  const { id, method } = activeDialog;
  activeDialog = null;
  dialogOverlay.classList.add("hidden");

  let response;
  if (cancelled) {
    response = { type: "extension_ui_response", id, cancelled: true };
  } else if (method === "confirm") {
    response = { type: "extension_ui_response", id, confirmed: value !== false };
  } else {
    response = { type: "extension_ui_response", id, value };
  }

  send(response);
}

dialogConfirm.addEventListener("click", () => {
  if (!activeDialog) return;
  const { method } = activeDialog;
  if (method === "confirm") {
    resolveDialog(true, false);
  } else if (method === "input") {
    resolveDialog(dialogInput.value, false);
  } else if (method === "editor") {
    resolveDialog(dialogEditor.value, false);
  }
});

dialogCancel.addEventListener("click", () => {
  if (!activeDialog) return;
  const { method } = activeDialog;
  if (method === "confirm") {
    resolveDialog(false, false); // confirmed: false (deny)
  } else {
    resolveDialog(null, true); // cancelled
  }
});

// ─── Slash command picker ─────────────────────────────────────────────────────

let cmdPickerActive = false;
let cmdFilterText = "";
let cmdSelectedIdx = -1;

function showCmdPicker(filter) {
  cmdFilterText = filter;
  const search = filter.toLowerCase();
  const matches = availableCommands.filter(c =>
    c.name.toLowerCase().includes(search) ||
    (c.description ?? "").toLowerCase().includes(search)
  ).slice(0, 12);

  if (matches.length === 0) {
    hideCmdPicker();
    return;
  }

  cmdList.innerHTML = "";
  matches.forEach((cmd, i) => {
    const item = document.createElement("div");
    item.className = "cmd-item" + (i === 0 ? " selected" : "");
    item.dataset.idx = i;

    const nameEl = document.createElement("span");
    nameEl.className = "cmd-item-name";
    nameEl.textContent = `/${cmd.name}`;

    const descEl = document.createElement("span");
    descEl.className = "cmd-item-desc";
    descEl.textContent = cmd.description ?? cmd.source ?? "";

    item.appendChild(nameEl);
    item.appendChild(descEl);
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // don't blur input
      selectCommand(cmd.name);
    });
    cmdList.appendChild(item);
  });

  cmdSelectedIdx = 0;
  cmdPicker.classList.remove("hidden");
  cmdPickerActive = true;
}

function hideCmdPicker() {
  cmdPicker.classList.add("hidden");
  cmdPickerActive = false;
  cmdSelectedIdx = -1;
}

function selectCommand(name) {
  hideCmdPicker();
  msgInput.value = `/${name} `;
  msgInput.focus();
  updateSendButton();
}

function moveCmdSelection(delta) {
  const items = cmdList.querySelectorAll(".cmd-item");
  if (!items.length) return;
  items[cmdSelectedIdx]?.classList.remove("selected");
  cmdSelectedIdx = Math.max(0, Math.min(items.length - 1, cmdSelectedIdx + delta));
  items[cmdSelectedIdx]?.classList.add("selected");
  items[cmdSelectedIdx]?.scrollIntoView({ block: "nearest" });
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function setConnectionStatus(state) {
  if (state === "connected") {
    if (!isStreaming) setAgentStatus("idle");
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

// ─── Sending ──────────────────────────────────────────────────────────────────

function getMode() {
  return document.querySelector('input[name="send-mode"]:checked')?.value ?? "prompt";
}

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !isConnected) return;
  hideCmdPicker();

  const mode = getMode();

  if (mode === "prompt") {
    appendUserBubble(text);
    // Use streamingBehavior so it works whether idle or running
    send({ type: "prompt", message: text, streamingBehavior: "steer" });
  } else if (mode === "steer") {
    appendSystemNote(`[steer] ${text}`);
    send({ type: "steer", message: text });
  } else if (mode === "follow_up") {
    appendSystemNote(`[follow-up] ${text}`);
    send({ type: "follow_up", message: text });
  }

  msgInput.value = "";
  msgInput.style.height = "auto";
  updateSendButton();
}

abortBtn.addEventListener("click", () => send({ type: "abort" }));

sendBtn.addEventListener("click", sendMessage);

msgInput.addEventListener("keydown", (e) => {
  if (cmdPickerActive) {
    if (e.key === "ArrowDown") { e.preventDefault(); moveCmdSelection(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); moveCmdSelection(-1); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const sel = cmdList.querySelector(".cmd-item.selected");
      if (sel) {
        const idx = parseInt(sel.dataset.idx);
        const matches = availableCommands.filter(c =>
          c.name.toLowerCase().includes(cmdFilterText.toLowerCase())
        );
        if (matches[idx]) selectCommand(matches[idx].name);
      }
      return;
    }
    if (e.key === "Escape") { hideCmdPicker(); return; }
  }

  if (e.key === "Enter" && !e.shiftKey && window.innerWidth > 600) {
    e.preventDefault();
    sendMessage();
  }
});

msgInput.addEventListener("input", () => {
  // Auto-grow
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + "px";
  updateSendButton();

  // Slash command picker
  const val = msgInput.value;
  if (val.startsWith("/") && !val.includes(" ")) {
    showCmdPicker(val.slice(1));
  } else {
    hideCmdPicker();
  }
});

msgInput.addEventListener("blur", () => {
  // Delay hide so mousedown on item fires first
  setTimeout(hideCmdPicker, 150);
});

// ─── Global keyboard shortcuts ────────────────────────────────────────────────

let lastEscapeTime = 0;

document.addEventListener("keydown", (e) => {
  // Alt+1/2/3 — switch send mode
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const modeMap = { "Digit1": "prompt", "Digit2": "steer", "Digit3": "follow_up" };
    if (modeMap[e.code]) {
      e.preventDefault();
      const radio = document.querySelector(`input[name="send-mode"][value="${modeMap[e.code]}"]`);
      if (radio) {
        radio.checked = true;
        radio.closest("label").classList.add("mode-flash");
        setTimeout(() => radio.closest("label").classList.remove("mode-flash"), 400);
      }
      return;
    }
    // Alt+M — toggle model dropdown
    if (e.code === "KeyM") {
      e.preventDefault();
      modelPanelOpen ? closeModelPanel() : openModelPanel();
      return;
    }
  }

  // Arrow keys / Enter — navigate open model panel
  if (modelPanelOpen && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const btns = getModelPanelBtns();
      const next = e.key === "ArrowDown"
        ? Math.min(modelPanelFocusIdx + 1, btns.length - 1)
        : Math.max(modelPanelFocusIdx - 1, 0);
      setModelPanelFocus(next);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const btns = getModelPanelBtns();
      if (modelPanelFocusIdx >= 0) btns[modelPanelFocusIdx]?.click();
      return;
    }
  }

  // Double Escape — abort (also closes model panel on first press)
  if (e.key === "Escape" && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (modelPanelOpen) { closeModelPanel(); return; }
    const now = Date.now();
    if (now - lastEscapeTime < 500) {
      e.preventDefault();
      if (!abortBtn.disabled) send({ type: "abort" });
      lastEscapeTime = 0;
    } else {
      lastEscapeTime = now;
    }
  }
});



// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
msgInput.focus();
