/**
 * pi-remote bridge server
 *
 * - Starts a pi agent session using the SDK
 * - Exposes a WebSocket server for the phone UI
 * - Forwards agent events to connected clients
 * - Accepts commands (prompt / steer / follow_up / abort / confirm_response)
 *   from the phone
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 7700);
const CWD = process.env.AGENT_CWD ?? process.cwd();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ServerEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; args: unknown }
  | { type: "tool_update"; toolName: string; output: string }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "auto_compaction_start" }
  | { type: "auto_compaction_end" }
  | { type: "auto_retry_start"; attempt: number }
  | { type: "auto_retry_end" }
  | { type: "confirm_request"; id: string; title: string; message: string; timeout: number }
  | { type: "history"; messages: HistoryMessage[] }
  | { type: "error"; message: string };

type ClientCommand =
  | { type: "prompt"; text: string }
  | { type: "steer"; text: string }
  | { type: "follow_up"; text: string }
  | { type: "abort" }
  | { type: "confirm_response"; id: string; confirmed: boolean };

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Agent session setup
// ---------------------------------------------------------------------------

const authStorage = AuthStorage.create();
const modelRegistry = new ModelRegistry(authStorage);

console.log(`[bridge] Starting pi agent session, cwd=${CWD}`);

const { session } = await createAgentSession({
  cwd: CWD,
  authStorage,
  modelRegistry,
  sessionManager: SessionManager.continueRecent(CWD).then
    ? await (async () => SessionManager.continueRecent(CWD))()
    : SessionManager.continueRecent(CWD),
});

console.log(`[bridge] Agent session ready (id=${session.sessionId})`);

// ---------------------------------------------------------------------------
// WebSocket client registry & helpers
// ---------------------------------------------------------------------------

const clients = new Set<WebSocket>();

// Pending confirm dialogs: id -> resolve function
const pendingConfirms = new Map<string, (confirmed: boolean) => void>();

function broadcast(event: ServerEvent) {
  const msg = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      // client disconnected; will be cleaned up on close
    }
  }
}

function sendTo(ws: WebSocket, event: ServerEvent) {
  try {
    ws.send(JSON.stringify(event));
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Convert session messages to plain history for new clients
// ---------------------------------------------------------------------------

function buildHistory(): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (text) history.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      if (text) history.push({ role: "assistant", content: text });
    }
  }
  return history;
}

// ---------------------------------------------------------------------------
// Subscribe to agent events
// ---------------------------------------------------------------------------

session.subscribe((event) => {
  switch (event.type) {
    case "message_update": {
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta") {
        process.stdout.write(e.delta);
        broadcast({ type: "text_delta", delta: e.delta });
      }
      break;
    }
    case "tool_execution_start":
      process.stdout.write(`\n\n[tool: ${event.toolName}] `);
      broadcast({ type: "tool_start", toolName: event.toolName, args: event.args });
      break;
    case "tool_execution_update":
      // Don't flood the terminal with tool output — just a dot per update
      process.stdout.write(".");
      broadcast({ type: "tool_update", toolName: event.toolName, output: event.output ?? "" });
      break;
    case "tool_execution_end":
      process.stdout.write(event.isError ? " ✗\n" : " ✓\n");
      broadcast({ type: "tool_end", toolName: event.toolName, isError: event.isError });
      break;
    case "agent_start":
      process.stdout.write("\n");
      broadcast({ type: "agent_start" });
      break;
    case "agent_end":
      process.stdout.write("\n");
      broadcast({ type: "agent_end" });
      break;
    case "auto_compaction_start":
      broadcast({ type: "auto_compaction_start" });
      break;
    case "auto_compaction_end":
      broadcast({ type: "auto_compaction_end" });
      break;
    case "auto_retry_start":
      broadcast({ type: "auto_retry_start", attempt: (event as any).attempt ?? 1 });
      break;
    case "auto_retry_end":
      broadcast({ type: "auto_retry_end" });
      break;
    case "extension_ui_request": {
      // safe-bash confirm dialog
      const req = event as any;
      if (req.method === "confirm") {
        const id = randomUUID();
        const timeout = req.timeout ?? 30000;
        broadcast({
          type: "confirm_request",
          id,
          title: req.title ?? "Confirm",
          message: req.message ?? "",
          timeout,
        });
        // Return a promise that resolves when phone responds (or times out)
        const result = new Promise<boolean>((resolve) => {
          pendingConfirms.set(id, resolve);
          setTimeout(() => {
            if (pendingConfirms.has(id)) {
              pendingConfirms.delete(id);
              resolve(false); // default: deny on timeout
            }
          }, timeout);
        });
        // The extension_ui_request handler expects us to return the result
        // through the event's respond callback if present
        if (typeof req.respond === "function") {
          result.then((confirmed) => req.respond({ confirmed }));
        }
      }
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// Command handler (phone → agent)
// ---------------------------------------------------------------------------

async function handleCommand(ws: WebSocket, cmd: ClientCommand) {
  try {
    switch (cmd.type) {
      case "prompt":
        if (session.isStreaming) {
          sendTo(ws, { type: "error", message: "Agent is busy. Use steer or follow_up." });
        } else {
          console.log(`\n[user] ${cmd.text}`);
          session.prompt(cmd.text).catch((err) => {
            broadcast({ type: "error", message: String(err) });
          });
        }
        break;
      case "steer":
        console.log(`\n[steer] ${cmd.text}`);
        await session.steer(cmd.text);
        break;
      case "follow_up":
        console.log(`\n[follow_up] ${cmd.text}`);
        await session.followUp(cmd.text);
        break;
      case "abort":
        await session.abort();
        break;
      case "confirm_response": {
        const resolve = pendingConfirms.get(cmd.id);
        if (resolve) {
          pendingConfirms.delete(cmd.id);
          resolve(cmd.confirmed);
        }
        break;
      }
    }
  } catch (err) {
    sendTo(ws, { type: "error", message: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Static file helpers
// ---------------------------------------------------------------------------

function serveFile(path: string): Response {
  try {
    const content = readFileSync(path);
    const ext = path.split(".").pop() ?? "";
    const mimeTypes: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "application/javascript; charset=utf-8",
      json: "application/json",
      svg: "image/svg+xml",
      ico: "image/x-icon",
    };
    return new Response(content, {
      headers: { "Content-Type": mimeTypes[ext] ?? "application/octet-stream" },
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

    // WebSocket upgrade
    if (req.headers.get("upgrade") === "websocket") {
      const ok = server.upgrade(req);
      if (!ok) return new Response("WebSocket upgrade failed", { status: 400 });
      return undefined as any;
    }

    // Static files
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    // Prevent path traversal
    const safePath = join(PUBLIC_DIR, pathname.replace(/\.\./g, ""));
    return serveFile(safePath);
  },

  websocket: {
    open(ws) {
      clients.add(ws as unknown as WebSocket);
      console.log(`[bridge] Client connected (total=${clients.size})`);
      // Send current history so phone can catch up
      sendTo(ws as unknown as WebSocket, { type: "history", messages: buildHistory() });
      // Tell phone whether agent is currently running
      if (session.isStreaming) {
        sendTo(ws as unknown as WebSocket, { type: "agent_start" });
      }
    },
    close(ws) {
      clients.delete(ws as unknown as WebSocket);
      console.log(`[bridge] Client disconnected (total=${clients.size})`);
    },
    message(ws, msg) {
      let cmd: ClientCommand;
      try {
        cmd = JSON.parse(typeof msg === "string" ? msg : msg.toString());
      } catch {
        sendTo(ws as unknown as WebSocket, { type: "error", message: "Invalid JSON" });
        return;
      }
      handleCommand(ws as unknown as WebSocket, cmd);
    },
  },
});

console.log(`[bridge] Listening on http://0.0.0.0:${PORT}`);
console.log(`[bridge] Open on your phone: http://<tailscale-ip>:${PORT}`);
