/**
 * pi-remote bridge server — v2 (RPC mode)
 *
 * Spawns `pi --mode rpc` as a child process and multiplexes its JSONL
 * stdin/stdout stream across multiple WebSocket clients.
 *
 * On new connection: fetches get_state + get_messages + get_commands from pi
 * and sends the responses to the connecting client so it can bootstrap.
 *
 * All pi events (no `id` field) are broadcast to every connected client.
 * Responses (`type: "response"`) are routed to the client that originated
 * the request, or broadcast for bridge-initiated requests.
 *
 * Extension UI: extension_ui_request events are broadcast; first client to
 * send extension_ui_response wins and it is forwarded to pi stdin.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { StringDecoder } from "string_decoder";
import { createInterface } from "readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 7700);
const CWD = process.env.AGENT_CWD ?? process.cwd();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");

// ---------------------------------------------------------------------------
// Spawn pi --mode rpc
// ---------------------------------------------------------------------------

console.log(`[bridge] Spawning pi --mode rpc, cwd=${CWD}`);

const pi = Bun.spawn(["pi", "--mode", "rpc"], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env },
});

pi.exited.then((code) => {
  console.log(`[bridge] pi process exited with code ${code}`);
  process.exit(code ?? 0);
});

// ---------------------------------------------------------------------------
// WebSocket client registry
// ---------------------------------------------------------------------------

const clients = new Set<any>();

// Pending response routes: requestId -> ws  (null = broadcast to all)
const pendingResponseRoutes = new Map<string, any | null>();

// Track which extension_ui_request ids have already been answered
const answeredDialogIds = new Set<string>();

let bridgeReqCounter = 0;
function nextBridgeId(): string {
  return `bridge-${++bridgeReqCounter}`;
}

// ---------------------------------------------------------------------------
// Communicate with pi
// ---------------------------------------------------------------------------

function sendToPi(cmd: object): void {
  const line = JSON.stringify(cmd) + "\n";
  pi.stdin.write(line);
  // No flush needed — Bun flushes automatically for pipe streams on each write
}

// ---------------------------------------------------------------------------
// JSONL reader on pi stdout (split on \n only — see RPC docs)
// ---------------------------------------------------------------------------

function attachJsonlReader(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const reader = stream.getReader();

  async function pump() {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.end();
        if (buffer.length > 0) {
          const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
          if (line) onLine(line);
        }
        break;
      }
      buffer += decoder.write(value);
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) onLine(line);
      }
    }
  }

  pump().catch((err) => console.error("[bridge] pi stdout read error:", err));
}

// ---------------------------------------------------------------------------
// Fan-out / route pi output to WebSocket clients
// ---------------------------------------------------------------------------

function broadcast(msg: string): void {
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      // disconnected; cleaned up in close handler
    }
  }
}

function sendToWs(ws: any, msg: string): void {
  try {
    ws.send(msg);
  } catch {
    // ignore
  }
}

attachJsonlReader(pi.stdout as ReadableStream<Uint8Array>, (line) => {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    console.error("[bridge] failed to parse pi output:", line);
    return;
  }

  // Log to terminal for visibility
  if (parsed.type === "message_update") {
    const e = parsed.assistantMessageEvent;
    if (e?.type === "text_delta") process.stdout.write(e.delta);
    else if (e?.type === "thinking_delta") process.stdout.write(`[think] ${e.delta}`);
  } else if (
    parsed.type === "tool_execution_start" ||
    parsed.type === "agent_start" ||
    parsed.type === "agent_end"
  ) {
    console.log(`[pi] ${JSON.stringify(parsed)}`);
  }

  // Route: responses with id → specific client or broadcast; events → broadcast
  if (parsed.type === "response" && parsed.id != null) {
    const target = pendingResponseRoutes.get(parsed.id);
    if (target !== undefined) {
      pendingResponseRoutes.delete(parsed.id);
      if (target === null) {
        broadcast(line);
      } else {
        sendToWs(target, line);
      }
      return;
    }
  }

  // Default: broadcast to all clients
  broadcast(line);
});

// ---------------------------------------------------------------------------
// WebSocket message handler (client → pi)
// ---------------------------------------------------------------------------

function handleClientMessage(ws: any, raw: string): void {
  let cmd: any;
  try {
    cmd = JSON.parse(raw);
  } catch {
    sendToWs(ws, JSON.stringify({ type: "response", command: "parse", success: false, error: "Invalid JSON" }));
    return;
  }

  // extension_ui_response: only forward the first response for each dialog id
  if (cmd.type === "extension_ui_response") {
    if (answeredDialogIds.has(cmd.id)) return; // already answered
    answeredDialogIds.add(cmd.id);
    sendToPi(cmd);
    return;
  }

  // Track response route so the reply goes back to this client
  if (cmd.id != null) {
    pendingResponseRoutes.set(cmd.id, ws);
  }

  sendToPi(cmd);

  // Fan-out user-visible commands to all OTHER clients so their UI stays in sync
  if (cmd.type === "prompt" || cmd.type === "steer" || cmd.type === "follow_up") {
    for (const other of clients) {
      if (other !== ws) sendToWs(other, raw);
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap a newly connected client
// ---------------------------------------------------------------------------

function bootstrapClient(ws: any): void {
  // Send get_state, get_messages, get_commands — route responses to this ws only
  const stateId = nextBridgeId();
  const messagesId = nextBridgeId();
  const commandsId = nextBridgeId();

  pendingResponseRoutes.set(stateId, ws);
  pendingResponseRoutes.set(messagesId, ws);
  pendingResponseRoutes.set(commandsId, ws);

  sendToPi({ type: "get_state", id: stateId });
  sendToPi({ type: "get_messages", id: messagesId });
  sendToPi({ type: "get_commands", id: commandsId });
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

function serveFile(path: string): Response {
  try {
    const content = readFileSync(path);
    const ext = path.split(".").pop() ?? "";
    const mime: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "application/javascript; charset=utf-8",
      json: "application/json",
      svg: "image/svg+xml",
      ico: "image/x-icon",
    };
    return new Response(content, {
      headers: { "Content-Type": mime[ext] ?? "application/octet-stream" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    if (req.headers.get("upgrade") === "websocket") {
      const ok = server.upgrade(req);
      if (!ok) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined as any;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = join(PUBLIC_DIR, pathname.replace(/\.\./g, ""));
    return serveFile(safePath);
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      console.log(`[bridge] Client connected (total=${clients.size})`);
      bootstrapClient(ws);
    },
    close(ws) {
      clients.delete(ws);
      // Remove any pending routes for this ws to avoid leaks
      for (const [id, target] of pendingResponseRoutes) {
        if (target === ws) pendingResponseRoutes.delete(id);
      }
      console.log(`[bridge] Client disconnected (total=${clients.size})`);
    },
    message(ws, msg) {
      handleClientMessage(ws, typeof msg === "string" ? msg : msg.toString());
    },
  },
});

console.log(`[bridge] Listening on http://0.0.0.0:${PORT}`);
console.log(`[bridge] Open on your phone: http://<tailscale-ip>:${PORT}`);
console.log(`[bridge] Terminal: type a prompt, prefix "> " for follow-up, "abort" to stop.`);
console.log();

// ---------------------------------------------------------------------------
// Terminal input loop (optional quick-testing without opening a browser)
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;

  if (text === "abort") {
    console.log("[abort]");
    sendToPi({ type: "abort" });
    return;
  }

  if (text.startsWith("> ")) {
    const msg = text.slice(2).trim();
    console.log(`\n[follow_up] ${msg}`);
    sendToPi({ type: "follow_up", message: msg });
  } else {
    // Use prompt with steer as streaming behavior so it works whether idle or running
    console.log(`\n[prompt] ${text}`);
    sendToPi({ type: "prompt", message: text, streamingBehavior: "steer" });
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on("SIGINT", () => {
  console.log("\n[bridge] Shutting down…");
  pi.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  pi.kill();
  process.exit(0);
});
