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
const sessionBtn     = document.getElementById("session-btn");
const sessionPanel   = document.getElementById("session-panel");
const sessionList    = document.getElementById("session-list");
const newSessionBtn  = document.getElementById("new-session-btn");
const modelBtn       = document.getElementById("model-btn");
const modelPanel     = document.getElementById("model-panel");
const modelList      = document.getElementById("model-list");
const sessionInfo    = document.getElementById("session-info");
const sessionStats   = document.getElementById("session-stats");
const forkBtn        = document.getElementById("fork-btn");
const exportBtn      = document.getElementById("export-btn");
const compactBtn     = document.getElementById("compact-btn");
const abortBtn       = document.getElementById("abort-btn");
const overflowBtn    = document.getElementById("overflow-btn");
const overflowPanel  = document.getElementById("overflow-panel");
const modeCycleBtn   = document.getElementById("mode-cycle");
const thinkingCycleBtn = document.getElementById("thinking-cycle");
const conversation   = document.getElementById("conversation");
const subagentMonitor = document.getElementById("subagent-monitor");
const subagentMonitorToggle = document.getElementById("subagent-monitor-toggle");
const subagentMonitorBody = document.getElementById("subagent-monitor-body");
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
const imageTray      = document.getElementById("image-tray");
const attachBtn      = document.getElementById("attach-btn");
const attachInput    = document.getElementById("attach-input");
const msgInput       = document.getElementById("msg-input");
const sendBtn        = document.getElementById("send-btn");

// ─── State ───────────────────────────────────────────────────────────────────
let ws               = null;
let isConnected      = false;
let isStreaming      = false;
let reconnectDelay   = 1000;
let reqCounter       = 0;

// Attached images waiting to be sent with the next message
let pendingImages    = []; // [{type:"image", data: base64, mimeType: string, preview: objectURL}]

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

// Current send mode
let currentMode = "prompt"; // "prompt" | "steer" | "follow_up"
const MODE_CYCLE = ["prompt", "steer", "follow_up"];
const MODE_LABELS = { prompt: "Prompt", steer: "Steer", follow_up: "Follow-up" };

// Current thinking level
let currentThinkingLevel = localStorage.getItem("thinking-level") ?? "none";
const THINKING_CYCLE = ["none", "low", "high"];
const THINKING_LABELS = { none: "Off", low: "Low", high: "High" };

// Streaming render state
let streamingTurn = null; // { textEl, thinkingEl, thinkingRaw, textRaw, toolCards: Map<toolCallId, el> }

// Subagent monitor state
let subagentMonitorMode = localStorage.getItem("subagent-monitor-mode") ?? "expanded"; // expanded | collapsed
if (subagentMonitorMode !== "expanded" && subagentMonitorMode !== "collapsed") {
  subagentMonitorMode = "collapsed";
}
const subagents = new Map(); // id -> state
const subagentGroups = new Map(); // parent toolCallId -> child ids[]

// ─── Unread / finish indicator ────────────────────────────────────────────────

const ORIGINAL_TITLE = "pi remote";
let unreadFinished = false;

function markFinished() {
  if (!document.hidden) return; // user is watching — no badge needed
  unreadFinished = true;
  document.title = "✓ pi remote";
}

function clearUnread() {
  unreadFinished = false;
  document.title = ORIGINAL_TITLE;
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && unreadFinished) clearUnread();
});

// ─── File reference autocomplete ───────────────────────────────────────────────

const autocompleteEl = document.getElementById("file-autocomplete");
const msgInputEl = document.getElementById("msg-input");

let fileList = [];
let autocompleteState = {
  visible: false,
  query: "",
  suggestions: [],
  selectedIdx: 0,
  atPos: 0, // character position of @ in the input
};

// Fuzzy score algorithm (Sublime Text style)
function fuzzyScore(query, str) {
  if (!query) return 1000; // Exact match, highest score
  const q = query.toLowerCase();
  const s = str.toLowerCase();
  let score = 0;
  let queryIdx = 0;
  let prevMatchIdx = -1;

  for (let i = 0; i < s.length && queryIdx < q.length; i++) {
    if (s[i] === q[queryIdx]) {
      // Consecutive character bonus
      const consecutiveBonus = prevMatchIdx === i - 1 ? 10 : 0;
      // Word boundary bonus (match after /)
      const wordBoundaryBonus = i === 0 || s[i - 1] === "/" ? 50 : 0;
      // Closer to start bonus
      const posBonus = Math.max(0, 100 - i);
      score += 100 + consecutiveBonus + wordBoundaryBonus + posBonus;
      prevMatchIdx = i;
      queryIdx++;
    }
  }

  return queryIdx === q.length ? score : 0;
}

function loadFileList() {
  if (fileList.length === 0) {
    sendWithId({ type: "list_files", id: nextId() });
  }
}

function updateAutocompleteSuggestions(query) {
  if (!query) {
    autocompleteState.suggestions = fileList.slice(0, 15);
  } else {
    const scored = fileList.map(file => ({
      file,
      score: fuzzyScore(query, file),
    }));
    autocompleteState.suggestions = scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map(item => item.file);
  }
  autocompleteState.selectedIdx = 0;
  renderAutocomplete();
}

// Re-render without changing selectedIdx (for keyboard navigation)
function rerenderAutocomplete() {
  renderAutocomplete();
}

function renderAutocomplete() {
  if (!autocompleteEl) return;
  
  autocompleteEl.innerHTML = "";
  const suggestions = autocompleteState.suggestions;

  if (suggestions.length === 0) {
    hideAutocomplete();
    return;
  }

  let focusedItem = null;
  for (let i = 0; i < suggestions.length; i++) {
    const item = document.createElement("div");
    item.className = `file-autocomplete-item ${i === autocompleteState.selectedIdx ? "focused" : ""}`;
    item.textContent = suggestions[i];
    item.addEventListener("click", () => selectAutocompleteSuggestion(i));
    item.addEventListener("mouseover", () => {
      document.querySelectorAll(".file-autocomplete-item").forEach(el => el.classList.remove("focused"));
      item.classList.add("focused");
      autocompleteState.selectedIdx = i;
    });
    autocompleteEl.appendChild(item);
    
    // Keep reference to focused item for scrolling
    if (i === autocompleteState.selectedIdx) {
      focusedItem = item;
    }
  }

  // Position the popup above the input
  if (msgInputEl) {
    const inputRect = msgInputEl.getBoundingClientRect();
    autocompleteEl.style.bottom = (window.innerHeight - inputRect.top + 4) + "px";
  }
  autocompleteEl.style.left = "12px";
  autocompleteEl.style.right = "12px";
  autocompleteEl.style.maxWidth = "none";

  autocompleteEl.classList.add("visible");
  autocompleteState.visible = true;
  
  // Scroll focused item into view
  if (focusedItem) {
    focusedItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function hideAutocomplete() {
  if (!autocompleteEl) return;
  autocompleteEl.classList.remove("visible");
  autocompleteEl.innerHTML = "";
  autocompleteState.visible = false;
  autocompleteState.suggestions = [];
}

function selectAutocompleteSuggestion(idx) {
  const suggestion = autocompleteState.suggestions[idx];
  if (!suggestion || !msgInputEl) return;

  const text = msgInputEl.value;
  // Replace @ and query with suggestion + space (no @ prefix to avoid re-triggering on backspace)
  const before = text.substring(0, autocompleteState.atPos) + suggestion + " ";
  const after = text.substring(msgInputEl.selectionStart);
  
  msgInputEl.value = before + after;
  msgInputEl.focus();
  msgInputEl.selectionStart = msgInputEl.selectionEnd = before.length;
  
  hideAutocomplete();
  msgInputEl.dispatchEvent(new Event("input", { bubbles: true }));
}

// Listen for @ in the input
if (msgInputEl) {
  msgInputEl.addEventListener("input", (e) => {
    const text = msgInputEl.value;
    const cursorPos = msgInputEl.selectionStart;

    // Find the last @ before cursor
    let atIdx = -1;
    for (let i = cursorPos - 1; i >= 0; i--) {
      if (text[i] === "@") {
        atIdx = i;
        break;
      } else if (text[i] === " " || text[i] === "\n") {
        // Stop at whitespace
        break;
      }
    }

    if (atIdx === -1) {
      hideAutocomplete();
      return;
    }

    // Only trigger if @ is preceded by whitespace/newline or is first character
    const charBeforeAt = atIdx > 0 ? text[atIdx - 1] : null;
    const isValidPosition = atIdx === 0 || charBeforeAt === " " || charBeforeAt === "\n";
    
    if (!isValidPosition) {
      hideAutocomplete();
      return;
    }

    // Get text after @
    const query = text.substring(atIdx + 1, cursorPos);

    // Only show autocomplete for printable characters after @
    if (!/^[a-zA-Z0-9._/-]*$/.test(query)) {
      hideAutocomplete();
      return;
    }

    autocompleteState.atPos = atIdx;
    autocompleteState.query = query;
    
    if (fileList.length === 0) {
      loadFileList();
    } else {
      updateAutocompleteSuggestions(query);
    }
  });

  // Keyboard navigation in autocomplete
  msgInputEl.addEventListener("keydown", (e) => {
    if (!autocompleteState.visible) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      autocompleteState.selectedIdx = Math.max(0, autocompleteState.selectedIdx - 1);
      rerenderAutocomplete();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopImmediatePropagation();
      autocompleteState.selectedIdx = Math.min(
        autocompleteState.suggestions.length - 1,
        autocompleteState.selectedIdx + 1
      );
      rerenderAutocomplete();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectAutocompleteSuggestion(autocompleteState.selectedIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideAutocomplete();
    }
  });
}

// Load file list on first connection
function onConnected() {
  loadFileList();
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function nextId() { return `client-${++reqCounter}`; }

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener("open", () => {
    isConnected = true;
    reconnectDelay = 1000;
    setConnectionStatus("connected");
    onConnected();
    // Restore saved thinking level
    if (currentThinkingLevel !== "none") {
      sendWithId({ type: "set_thinking_level", level: currentThinkingLevel });
    }
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

  // Session info (folder + branch)
  if (msg.type === "session_info") {
    if (sessionInfo) {
      sessionInfo.textContent = `${msg.folder} • ${msg.branch}`;
      sessionInfo.title = `Folder: ${msg.folder}\nBranch: ${msg.branch}`;
    }
    return;
  }

  // Agent events
  switch (msg.type) {
    case "agent_start":
      isStreaming = true;
      setAgentStatus("running");
      startStreamingTurn();
      if (navigator.vibrate) navigator.vibrate(30);
      startStatsPolling();
      break;

    case "agent_end":
      isStreaming = false;
      setAgentStatus("idle");
      finaliseStreamingTurn();
      stopStatsPolling();
      // Refresh stats after agent finishes
      requestStats();
      if (navigator.vibrate) navigator.vibrate([20, 60, 20]);
      markFinished();
      break;

    case "message_update":
      handleMessageUpdate(msg);
      break;

    case "tool_execution_start":
      handleSubagentToolStart(msg);
      handleToolStart(msg);
      break;

    case "tool_execution_update":
      handleSubagentToolUpdate(msg);
      handleToolUpdate(msg);
      break;

    case "tool_execution_end":
      handleSubagentToolEnd(msg);
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

    case "list_files":
      fileList = msg.data.files ?? [];
      if (autocompleteState.visible) {
        updateAutocompleteSuggestions(autocompleteState.query);
      }
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

    case "list_sessions":
      renderSessionList(msg.data?.sessions ?? []);
      break;

    case "get_fork_messages":
      renderForkList(msg.data?.messages ?? []);
      break;

    case "fork":
      if (!msg.data?.cancelled) {
        appendSystemNote(`✓ Forked — new branch from that message`);
        conversation.innerHTML = "";
        streamingTurn = null;
        send({ type: "get_messages", id: nextId() });
      }
      break;

    case "switch_session":
      if (!msg.data?.cancelled) {
        appendSystemNote("✓ Session loaded");
        conversation.innerHTML = "";
        streamingTurn = null;
        send({ type: "get_messages", id: nextId() });
        requestStats();
      }
      break;

    case "new_session":
      if (!msg.data?.cancelled) {
        appendSystemNote("✓ New session started");
        conversation.innerHTML = "";
        streamingTurn = null;
        requestStats();
      }
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

let statsPollingInterval = null;

function startStatsPolling() {
  if (statsPollingInterval) return;
  statsPollingInterval = setInterval(() => {
    if (isStreaming) requestStats();
  }, 2500);
}

function stopStatsPolling() {
  if (statsPollingInterval) {
    clearInterval(statsPollingInterval);
    statsPollingInterval = null;
  }
}

// ─── Code block copy buttons ─────────────────────────────────────────────────

function addCopyButtons(containerEl) {
  containerEl.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-btn")) return; // already added
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent ?? pre.textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
      }).catch(() => {});
    });
    pre.style.position = "relative";
    pre.appendChild(btn);
  });
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
        const images = extractUserImages(msg.content);
        if (text || images.length) appendUserBubble(text, images);
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
            addCopyButtons(textEl);
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
  let text = "";
  
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
  }
  
  // Extract skill/prompt names if present and reconstruct the original command
  const skillMatch = text.match(/<skill\s+name="([^"]+)"/);
  if (skillMatch) {
    const skillName = skillMatch[1];
    // Extract any args that come after the skill block (e.g., PR ID)
    const argsAfter = text.replace(/<skill[^>]*>[\s\S]*?<\/skill>/g, "").trim();
    return `/skill:${skillName}${argsAfter ? " " + argsAfter : ""}`;
  }
  
  const promptMatch = text.match(/<prompt\s+name="([^"]+)"/);
  if (promptMatch) {
    const promptName = promptMatch[1];
    // Extract any args that come after the prompt block
    const argsAfter = text.replace(/<prompt[^>]*>[\s\S]*?<\/prompt>/g, "").trim();
    return `/prompt:${promptName}${argsAfter ? " " + argsAfter : ""}`;
  }
  
  // If no skill/prompt blocks, just clean up and return
  text = text.replace(/<skill[^>]*>[\s\S]*?<\/skill>/g, "");
  text = text.replace(/<prompt[^>]*>[\s\S]*?<\/prompt>/g, "");
  text = text.replace(/\s+/g, " ").trim();
  
  return text;
}

function extractUserImages(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(c => c.type === "image" && c.data && c.mimeType);
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
    addCopyButtons(t.textEl);
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

function appendUserBubble(text, images) {
  const row = document.createElement("div");
  row.className = "bubble-row user";
  const label = document.createElement("div");
  label.className = "sender-label";
  label.textContent = "You";
  const b = document.createElement("div");
  b.className = "bubble user";
  if (images?.length) {
    const tray = document.createElement("div");
    tray.className = "bubble-image-tray";
    images.forEach(img => {
      const el = document.createElement("img");
      el.src = `data:${img.mimeType};base64,${img.data}`;
      el.alt = "attachment";
      el.className = "bubble-image";
      tray.appendChild(el);
    });
    b.appendChild(tray);
  }
  if (text) {
    const textNode = document.createElement("span");
    textNode.textContent = text;
    b.appendChild(textNode);
  }
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
  // Always start collapsed (hidden) - both streaming and historical views match
  pre.className = "thinking-content hidden";
  pre.textContent = content;

  toggle.addEventListener("click", () => {
    const isNowHidden = pre.classList.toggle("hidden");
    toggle.setAttribute("aria-expanded", String(!isNowHidden));
    toggle.textContent = isNowHidden ? "💭 Thinking…" : "💭 Thinking (hide)";
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

// ─── Subagent monitor ─────────────────────────────────────────────────────────

function shorten(text, max = 90) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function formatElapsedMs(start, end) {
  const ms = Math.max(0, (end ?? Date.now()) - start);
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  return min > 0 ? `${min}m ${sec % 60}s` : `${sec}s`;
}

function statusIcon(status) {
  if (status === "running") return "⟳";
  if (status === "error") return "✗";
  return "✓";
}

function extractAgentName(name) {
  if (!name) return "Agent";
  if (name.includes("story-orchestrator")) return "Story Orchestrator";
  if (name.includes("scout-and-plan")) return "Scout & Plan";
  return name;
}

function cycleSubagentMode() {
  const modes = ["expanded", "collapsed"];
  const idx = modes.indexOf(subagentMonitorMode);
  subagentMonitorMode = modes[(idx + 1) % modes.length];
  localStorage.setItem("subagent-monitor-mode", subagentMonitorMode);
  renderSubagentMonitor();
}

function renderSubagentMonitor() {
  if (!subagentMonitor || !subagentMonitorBody || !subagentMonitorToggle) return;

  const items = [...subagents.values()].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (a.status !== "running" && b.status === "running") return 1;
    return b.startTime - a.startTime;
  });

  const running = items.filter(x => x.status === "running").length;
  const done = items.filter(x => x.status === "complete").length;
  const err = items.filter(x => x.status === "error").length;

  if (items.length === 0) {
    subagentMonitor.classList.add("hidden");
    return;
  }

  subagentMonitor.classList.remove("hidden");
  subagentMonitorToggle.textContent = `🔄 Subagents · ${running} running, ${done} done${err ? `, ${err} error` : ""} [${subagentMonitorMode}]`;

  if (subagentMonitorMode === "collapsed") {
    subagentMonitorBody.classList.add("hidden");
    return;
  }

  subagentMonitorBody.classList.remove("hidden");
  subagentMonitorBody.innerHTML = "";

  items.forEach((a) => {
    const row = document.createElement("div");
    row.className = "subagent-row";

    const main = document.createElement("div");
    main.className = "subagent-main";
    const parallelTag = a.parallelTotal ? ` [${(a.parallelIndex ?? 0) + 1}/${a.parallelTotal}]` : "";
    main.textContent = `${statusIcon(a.status)} ${a.name}${parallelTag} (${formatElapsedMs(a.startTime, a.endTime)})`;

    row.appendChild(main);

    if (a.task) {
      const task = document.createElement("div");
      task.className = "subagent-task";
      task.textContent = `Task: ${shorten(a.task, 120)}`;
      row.appendChild(task);
    }

    const out = a.output?.length ? a.output[a.output.length - 1] : (a.result ?? "");
    if (out) {
      const output = document.createElement("div");
      output.className = "subagent-output";
      output.textContent = shorten(out.replace(/\s+/g, " "), 120);
      row.appendChild(output);
    }

    subagentMonitorBody.appendChild(row);
  });
}

function startSubagentEntry(id, name, task, extra = {}) {
  subagents.set(id, {
    id,
    name: extractAgentName(name),
    task,
    status: "running",
    startTime: Date.now(),
    endTime: null,
    output: [],
    result: "",
    ...extra,
  });
}

function isSubagentToolName(name) {
  return typeof name === "string" && name.toLowerCase().includes("subagent");
}

function handleSubagentToolStart(msg) {
  if (!isSubagentToolName(msg.toolName)) return;
  const params = (msg.params ?? msg.args ?? {});
  const groupIds = [];
  let startedAny = false;

  if (params.agent && params.task) {
    startSubagentEntry(msg.toolCallId, params.agent, params.task, { parentToolCallId: msg.toolCallId });
    groupIds.push(msg.toolCallId);
    startedAny = true;
  }

  if (Array.isArray(params.tasks)) {
    params.tasks.forEach((t, i) => {
      if (!t?.agent || !t?.task) return;
      const id = `${msg.toolCallId}::${i}`;
      startSubagentEntry(id, t.agent, t.task, {
        parentToolCallId: msg.toolCallId,
        parallelIndex: i,
        parallelTotal: params.tasks.length,
      });
      groupIds.push(id);
      startedAny = true;
    });
  }

  if (Array.isArray(params.chain)) {
    params.chain.forEach((c, i) => {
      if (!c?.agent || !c?.task) return;
      const id = `${msg.toolCallId}::${i}`;
      startSubagentEntry(id, c.agent, c.task, {
        parentToolCallId: msg.toolCallId,
      });
      groupIds.push(id);
      startedAny = true;
    });
  }

  if (!startedAny) {
    console.debug("[subagent-monitor] Unparsed subagent start payload", {
      toolName: msg.toolName,
      toolCallId: msg.toolCallId,
      params: msg.params,
      args: msg.args,
      raw: msg,
    });
    startSubagentEntry(msg.toolCallId, msg.toolName ?? "subagent", "(task unavailable)", { parentToolCallId: msg.toolCallId });
    groupIds.push(msg.toolCallId);
  }

  if (groupIds.length > 0) {
    subagentGroups.set(msg.toolCallId, groupIds);
    renderSubagentMonitor();
  }
}

function handleSubagentToolUpdate(msg) {
  if (!isSubagentToolName(msg.toolName)) return;
  const deltaText = msg.delta || extractToolResultText(msg.partialResult?.content ?? []);
  if (!deltaText) return;

  const direct = subagents.get(msg.toolCallId);
  if (direct && direct.status === "running") {
    direct.output.push(deltaText);
    renderSubagentMonitor();
    return;
  }

  const group = subagentGroups.get(msg.toolCallId) ?? [];
  const running = group.map(id => subagents.get(id)).filter(a => a && a.status === "running");
  const target = running[0] ?? (group.length ? subagents.get(group[0]) : null);
  if (target) {
    target.output.push(deltaText);
    renderSubagentMonitor();
  }
}

function handleSubagentToolEnd(msg) {
  if (!isSubagentToolName(msg.toolName)) return;
  let resultText = extractToolResultText(msg.result?.content ?? []);

  const completeOne = (a) => {
    if (!a) return;
    a.status = msg.isError ? "error" : "complete";
    a.endTime = Date.now();
    if (resultText) a.result = resultText;
  };

  const direct = subagents.get(msg.toolCallId);
  if (direct) {
    completeOne(direct);
  }

  const group = subagentGroups.get(msg.toolCallId) ?? [];
  group.forEach((id) => completeOne(subagents.get(id)));

  renderSubagentMonitor();
}

setInterval(() => {
  if ([...subagents.values()].some(a => a.status === "running")) {
    renderSubagentMonitor();
  }
}, 1000);

if (subagentMonitorToggle) {
  subagentMonitorToggle.addEventListener("click", cycleSubagentMode);
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
  return currentMode;
}

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || !isConnected) return;
  hideCmdPicker();

  // Handle /new command to start a new session
  if (text === "/new" || text.startsWith("/new ")) {
    sendWithId({ type: "new_session" });
    msgInput.value = "";
    msgInput.style.height = "auto";
    updateSendButton();
    return;
  }

  const mode = getMode();
  const images = pendingImages.length > 0
    ? pendingImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
    : undefined;

  if (mode === "prompt") {
    appendUserBubble(text, images);
    // Use streamingBehavior so it works whether idle or running
    const cmd = { type: "prompt", message: text, streamingBehavior: "steer" };
    if (images) cmd.images = images;
    send(cmd);
  } else if (mode === "steer") {
    appendSystemNote(`[steer] ${text}`);
    const cmd = { type: "steer", message: text };
    if (images) cmd.images = images;
    send(cmd);
  } else if (mode === "follow_up") {
    appendSystemNote(`[follow-up] ${text}`);
    const cmd = { type: "follow_up", message: text };
    if (images) cmd.images = images;
    send(cmd);
  }

  // Clear pending images
  pendingImages.forEach(img => URL.revokeObjectURL(img.preview));
  pendingImages = [];
  renderImageTray();

  msgInput.value = "";
  msgInput.style.height = "auto";
  updateSendButton();
}

abortBtn.addEventListener("click", () => send({ type: "abort" }));

forkBtn.addEventListener("click", openForkPanel);

exportBtn.addEventListener("click", () => {
  // Grab the rendered conversation HTML and wrap it in a minimal standalone page
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>pi remote — exported conversation</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d0d0d; color: #e8e8e8; margin: 0; padding: 20px; }
  .turn { margin-bottom: 16px; }
  .bubble { max-width: 80%; padding: 10px 14px; border-radius: 12px; margin-bottom: 6px; word-break: break-word; }
  .bubble.user { background: #23204a; border: 1px solid #7c6af7; color: #d6d0ff; margin-left: auto; }
  .bubble.assistant { background: #1a1a1a; border: 1px solid #2e2e2e; }
  .bubble.system-note { color: #888; font-style: italic; font-size: 12px; text-align: center; }
  .bubble-row.user { display: flex; flex-direction: column; align-items: flex-end; }
  pre { background: #0a0a0a; border: 1px solid #2e2e2e; border-radius: 8px; padding: 12px; overflow-x: auto; }
  code { font-family: monospace; font-size: 12px; }
  .copy-btn { display: none; }
</style>
</head>
<body>
${conversation.innerHTML}
</body>
</html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pi-conversation-${new Date().toISOString().slice(0,19).replace(/:/g,"-")}.html`;
  a.click();
  URL.revokeObjectURL(url);
});

compactBtn.addEventListener("click", () => {
  appendSystemNote("⟳ Requesting compaction…");
  sendWithId({ type: "compact" });
});

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
        // Use same filter as showCmdPicker to ensure consistency
        const search = cmdFilterText.toLowerCase();
        const matches = availableCommands.filter(c =>
          c.name.toLowerCase().includes(search) ||
          (c.description ?? "").toLowerCase().includes(search)
        ).slice(0, 12);
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
      applyMode(modeMap[e.code]);
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



// ─── Image attachment ─────────────────────────────────────────────────────────

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is "data:image/png;base64,XXXX" — strip the prefix
      const result = reader.result;
      const b64 = result.split(",")[1];
      resolve({ type: "image", data: b64, mimeType: file.type || "image/png" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const img = await readFileAsBase64(file);
      img.preview = URL.createObjectURL(file);
      pendingImages.push(img);
    } catch (e) {
      appendErrorBubble(`Failed to read image: ${e.message}`);
    }
  }
  renderImageTray();
}

function renderImageTray() {
  imageTray.innerHTML = "";
  if (pendingImages.length === 0) {
    imageTray.classList.add("hidden");
    return;
  }
  imageTray.classList.remove("hidden");
  pendingImages.forEach((img, idx) => {
    const thumb = document.createElement("div");
    thumb.className = "image-thumb";
    const im = document.createElement("img");
    im.src = img.preview;
    im.alt = "attachment";
    const rm = document.createElement("button");
    rm.className = "image-remove";
    rm.textContent = "✕";
    rm.addEventListener("click", () => {
      URL.revokeObjectURL(img.preview);
      pendingImages.splice(idx, 1);
      renderImageTray();
    });
    thumb.appendChild(im);
    thumb.appendChild(rm);
    imageTray.appendChild(thumb);
  });
}

attachBtn.addEventListener("click", () => attachInput.click());
attachInput.addEventListener("change", () => {
  if (attachInput.files?.length) {
    addImages([...attachInput.files]);
    attachInput.value = "";
  }
});

// Paste support (clipboard images)
document.addEventListener("paste", async (e) => {
  const items = [...(e.clipboardData?.items ?? [])];
  const imageItems = items.filter(it => it.kind === "file" && it.type.startsWith("image/"));
  if (imageItems.length === 0) return;
  e.preventDefault();
  const files = imageItems.map(it => it.getAsFile()).filter(Boolean);
  await addImages(files);
  msgInput.focus();
});

// Drag and drop support
let dragCounter = 0; // Track nested drag events

document.addEventListener("dragenter", (e) => {
  dragCounter++;
  const items = [...(e.dataTransfer?.items ?? [])];
  const hasImages = items.some(it => it.kind === "file" && it.type.startsWith("image/"));
  if (hasImages) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    document.body.classList.add("drag-over");
  }
});

document.addEventListener("dragleave", (e) => {
  dragCounter--;
  if (dragCounter === 0) {
    document.body.classList.remove("drag-over");
  }
});

document.addEventListener("dragover", (e) => {
  const items = [...(e.dataTransfer?.items ?? [])];
  const hasImages = items.some(it => it.kind === "file" && it.type.startsWith("image/"));
  if (hasImages) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});

document.addEventListener("drop", async (e) => {
  dragCounter = 0;
  document.body.classList.remove("drag-over");
  
  const items = [...(e.dataTransfer?.items ?? [])];
  const imageItems = items.filter(it => it.kind === "file" && it.type.startsWith("image/"));
  if (imageItems.length === 0) return;
  
  e.preventDefault();
  const files = imageItems.map(it => it.getAsFile()).filter(Boolean);
  await addImages(files);
  msgInput.focus();
});

// ─── Conversation forking ─────────────────────────────────────────────────────

let forkMessages = []; // [{entryId, text}]
let forkPanelOpen = false;
const forkOverlay = (() => {
  const el = document.createElement("div");
  el.id = "fork-overlay";
  el.className = "hidden";
  el.innerHTML = `
    <div id="fork-box">
      <div id="fork-header">
        <span>Fork from message</span>
        <button id="fork-close" class="btn-small">✕</button>
      </div>
      <div id="fork-list"></div>
    </div>`;
  document.body.appendChild(el);
  return el;
})();
const forkList = document.getElementById("fork-list");
const forkClose = document.getElementById("fork-close");

forkClose.addEventListener("click", closeForkPanel);
forkOverlay.addEventListener("click", (e) => { if (e.target === forkOverlay) closeForkPanel(); });

function openForkPanel() {
  forkOverlay.classList.remove("hidden");
  forkPanelOpen = true;
  // Fetch fork messages
  const id = nextId();
  send({ type: "get_fork_messages", id });
}

function closeForkPanel() {
  forkOverlay.classList.add("hidden");
  forkPanelOpen = false;
}

function renderForkList(messages) {
  forkList.innerHTML = "";
  if (!messages.length) {
    forkList.innerHTML = '<div class="session-empty">No messages to fork from</div>';
    return;
  }
  messages.forEach((m) => {
    const item = document.createElement("button");
    item.className = "fork-item";
    item.textContent = m.text.length > 120 ? m.text.slice(0, 117) + "…" : m.text;
    item.addEventListener("click", () => {
      closeForkPanel();
      sendWithId({ type: "fork", entryId: m.entryId });
      appendSystemNote(`⑂ Forking from: "${m.text.slice(0, 60)}${m.text.length > 60 ? "…" : ""}"`);
    });
    forkList.appendChild(item);
  });
}

// ─── Session switching ────────────────────────────────────────────────────────

let sessionPanelOpen = false;

function openSessionPanel() {
  sessionPanel.classList.remove("hidden");
  sessionPanelOpen = true;
  // Fetch sessions list
  const id = nextId();
  pendingSessionListId = id;
  send({ type: "list_sessions", id });
}

function closeSessionPanel() {
  sessionPanel.classList.add("hidden");
  sessionPanelOpen = false;
}

let pendingSessionListId = null;

sessionBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  sessionPanelOpen ? closeSessionPanel() : openSessionPanel();
});

newSessionBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  closeSessionPanel();
  sendWithId({ type: "new_session" });
  appendSystemNote("↻ Starting new session…");
});

document.addEventListener("click", (e) => {
  const overflowSessionsBtn = document.getElementById("overflow-sessions");
  if (sessionPanelOpen && !sessionPanel.contains(e.target) && e.target !== sessionBtn && e.target !== overflowSessionsBtn) {
    closeSessionPanel();
  }
});

function renderSessionList(sessions) {
  sessionList.innerHTML = "";
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "session-empty";
    empty.textContent = "No saved sessions";
    sessionList.appendChild(empty);
    return;
  }
  sessions.forEach((s) => {
    const item = document.createElement("button");
    item.className = "session-item";
    const ts = new Date(s.mtime).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const name = document.createElement("span");
    name.className = "session-item-name";
    name.textContent = s.name;
    const time = document.createElement("span");
    time.className = "session-item-time";
    time.textContent = ts;
    item.appendChild(name);
    item.appendChild(time);
    item.addEventListener("click", () => {
      closeSessionPanel();
      sendWithId({ type: "switch_session", sessionPath: s.path });
      appendSystemNote(`↻ Switching session…`);
    });
    sessionList.appendChild(item);
  });
}



// ─── Mode control ────────────────────────────────────────────────────────────

function applyMode(mode) {
  currentMode = mode;
  // Segmented buttons
  document.querySelectorAll(".mode-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  // Cycle button
  modeCycleBtn.textContent = MODE_LABELS[mode] ?? mode;
}

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyMode(btn.dataset.mode));
});

modeCycleBtn.addEventListener("click", () => {
  const next = MODE_CYCLE[(MODE_CYCLE.indexOf(currentMode) + 1) % MODE_CYCLE.length];
  applyMode(next);
});

// ─── Thinking level control ───────────────────────────────────────────────────

function applyThinkingLevel(level, sendRpc = true) {
  currentThinkingLevel = level;
  localStorage.setItem("thinking-level", level);

  // Segmented buttons
  document.querySelectorAll(".thinking-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.level === level);
  });
  // Cycle button
  thinkingCycleBtn.textContent = THINKING_LABELS[level] ?? level;
  thinkingCycleBtn.classList.toggle("active-glow", level !== "none");

  if (sendRpc) sendWithId({ type: "set_thinking_level", level });
}

document.querySelectorAll(".thinking-btn").forEach((btn) => {
  btn.addEventListener("click", () => applyThinkingLevel(btn.dataset.level));
});

thinkingCycleBtn.addEventListener("click", () => {
  const next = THINKING_CYCLE[(THINKING_CYCLE.indexOf(currentThinkingLevel) + 1) % THINKING_CYCLE.length];
  applyThinkingLevel(next);
});

// Apply saved thinking level on load (RPC sent after first connect)
applyThinkingLevel(currentThinkingLevel, false);

// ─── Overflow menu ────────────────────────────────────────────────────────────

let overflowOpen = false;

overflowBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  overflowOpen = !overflowOpen;
  overflowPanel.classList.toggle("hidden", !overflowOpen);
});

document.addEventListener("click", (e) => {
  if (overflowOpen && !overflowPanel.contains(e.target) && e.target !== overflowBtn) {
    overflowOpen = false;
    overflowPanel.classList.add("hidden");
  }
});

function closeOverflow() {
  overflowOpen = false;
  overflowPanel.classList.add("hidden");
}

document.getElementById("overflow-sessions").addEventListener("click", (e) => {
  e.stopPropagation();
  closeOverflow();
  openSessionPanel();
});

document.getElementById("overflow-fork").addEventListener("click", () => {
  closeOverflow();
  openForkPanel();
});

document.getElementById("overflow-export").addEventListener("click", () => {
  closeOverflow();
  exportBtn.click();
});

document.getElementById("overflow-compact").addEventListener("click", () => {
  closeOverflow();
  compactBtn.click();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

connect();
msgInput.focus();
