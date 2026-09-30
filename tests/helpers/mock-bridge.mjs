// Mock Unity Bridge — reusable test double for the plugin's HTTP bridge.
// Speaks the same protocol the real MCPBridgeServer exposes:
//   GET  /api/ping                     → instance identity (discovery reads projectName/projectPath/…)
//   POST /api/queue/submit             → { ticketId, status, position }        (202)
//   GET  /api/queue/status?ticketId=X  → ticket object ({ status, result })
//   GET  /api/queue/info               → queue stats
//   GET  /api/context[/{category}]     → project context (404 by default, like a project without Assets/MCP/Context)
//   POST /api/dialog/click             → answer the simulated native dialog (protocolVersion 3)
//   POST /api/{route}                  → legacy synchronous execution
// Listens on an ephemeral port (127.0.0.1:0) so parallel test files never collide.

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @typedef {{ route: string, params: object, headers: object, via: "queue"|"legacy" }} SeenRequest */

export class MockBridge {
  /**
   * @param {object} [options]
   * @param {"queue"|"legacy"} [options.mode] "queue" (default) answers queue/submit; "legacy" 404s it so the server falls back to sync POSTs.
   * @param {object} [options.instance] Fields merged into the /api/ping identity payload.
   * @param {number} [options.processingDelayMs] Simulated queue processing delay (default 0 = complete immediately).
   */
  constructor(options = {}) {
    this.mode = options.mode || "queue";
    this.instance = {
      status: "ok",
      projectName: "MockProject",
      projectPath: "C:/Mock/Project",
      unityVersion: "6000.0.0f1",
      isClone: false,
      cloneIndex: -1,
      // A queue-less plugin predates the capability handshake, so it advertises no versions.
      ...(this.mode === "legacy" ? {} : { protocolVersion: 2, pluginVersion: "9.9.9-mock", epoch: "mock-epoch-1" }),
      ...options.instance,
    };
    this.processingDelayMs = options.processingDelayMs ?? 0;
    /**
     * Simulated main-thread state reported with every queue/status (protocolVersion 2).
     * `frozen: true` keeps tickets Queued forever, like a blocked Unity main thread.
     */
    this.editor = { mainThreadStallMs: 0, busy: false, busyReason: null, executing: null, frozen: false };
    /** @type {Array<{ticketId: string, result: object}>} queue/cancel calls received */
    this.cancels = [];
    /**
     * Native-dialog simulation (protocolVersion 3). With `holdDialog` set, the next ticket starts
     * Executing and raises that dialog, like File > New Scene on a dirty scene. A click answers
     * `editor.dialog`; the next entry of `dialogQueue` then appears (chained dialogs), and once
     * none is left the held ticket completes.
     * @type {object|null}
     */
    this.holdDialog = null;
    /** @type {object[]} */
    this.dialogQueue = [];
    /** @type {Array<{dialogId: string, button: string}>} dialog/click calls received */
    this.clicks = [];
    this._held = null;
    /** @type {Map<string, (params: object) => object>} route → responder returning the plugin-side result object */
    this.routes = new Map();
    /** @type {SeenRequest[]} */
    this.seen = [];
    /** @type {(cat: string|null) => object|null} return null → 404 (project without context) */
    this.contextProvider = () => null;
    this._tickets = new Map();
    this._ticketCounter = 0;
    this._server = null;
    this.port = 0;
  }

  /** Register a responder for a plugin route (e.g. "editor/state"). Return value is the ticket `result` / legacy body. */
  on(route, responder) {
    this.routes.set(route, responder);
    return this;
  }

  /**
   * Default plugin-side behavior for unregistered routes. Plugin handlers return RAW
   * result objects (no {success,data} envelope) — the Node bridge adds that wrapper.
   * (Some real handlers do include their own `success` field, which is why production
   * responses can show a double envelope; fixtures model the common raw shape.)
   */
  _defaultResponder(route, params) {
    return { mock: true, route, echo: params };
  }

  _resolve(route, params) {
    const responder = this.routes.get(route);
    return responder ? responder(params) : this._defaultResponder(route, params);
  }

  start() {
    return new Promise((resolve) => {
      this._server = http.createServer((req, res) => this._handle(req, res));
      this._server.listen(0, "127.0.0.1", () => {
        this.port = this._server.address().port;
        resolve(this);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
      // Drop keep-alive sockets so close() doesn't hang the test process.
      this._server.closeAllConnections?.();
    });
  }

  /**
   * Environment for spawning the MCP server against this mock: pins every port knob
   * to the mock and isolates the instance registry + home-derived paths into a temp dir.
   */
  env() {
    const isolatedDir = mkdtempSync(join(tmpdir(), "umcp-test-"));
    return {
      UNITY_BRIDGE_HOST: "127.0.0.1",
      UNITY_BRIDGE_PORT: String(this.port),
      UNITY_PORT_RANGE_START: String(this.port),
      UNITY_PORT_RANGE_END: String(this.port),
      UNITY_INSTANCE_REGISTRY: join(isolatedDir, "instances.json"),
      UNITY_QUEUE_POLL_INTERVAL: "10",
      UNITY_QUEUE_POLL_MAX: "50",
      UNITY_QUEUE_POLL_TIMEOUT: "15000",
      UNITY_BRIDGE_TIMEOUT: "15000",
      LOCALAPPDATA: isolatedDir,
      HOME: isolatedDir,
    };
  }

  /** Live editor state as the v2 plugin's MCPEditorHealth reports it. */
  _editorSnapshot() {
    const { frozen, ...state } = this.editor;
    return {
      epoch: this.instance.epoch,
      isPlaying: false,
      isPaused: false,
      isCompiling: false,
      isUpdating: false,
      isBakingLighting: false,
      applicationFocused: true,
      ...(this._held ? { executing: this._held.route, executingTicketId: this._held.ticket.ticketId } : {}),
      ...state,
    };
  }

  /** Complete the ticket a dialog is holding (as if a human answered it in Unity). */
  releaseHeld() {
    const held = this._held;
    this._held = null;
    if (held) held.complete();
  }

  /** POST /api/dialog/click — mirrors the plugin's MCPDialogProbe.Click outcomes. */
  _handleDialogClick(res, body) {
    const { dialogId, button } = JSON.parse(body || "{}");
    this.clicks.push({ dialogId, button });
    const dialog = this.editor.dialog;
    if (!dialog) return this._json(res, 404, { error: "No dialog is blocking the editor (it may already have been answered)." });
    if (dialog.id !== dialogId) {
      return this._json(res, 409, { error: `The blocking dialog is now "${dialog.title}" (id ${dialog.id}), not ${dialogId}. Read it before answering.`, current: dialog });
    }
    const label = (dialog.buttons || []).find((b) => b.toLowerCase() === String(button).toLowerCase());
    if (!label) return this._json(res, 400, { error: `"${dialog.title}" has no button "${button}".`, current: dialog });

    this.editor.dialog = this.dialogQueue.shift() ?? null;
    if (!this.editor.dialog) this.releaseHeld();
    return this._json(res, 200, { clicked: true, button: label, dialog: dialog.title, dismissed: true });
  }

  _json(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  }

  _handle(req, res) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const path = url.pathname.replace(/^\/api\//, "");
      const v2 = typeof this.instance.protocolVersion === "number" && this.instance.protocolVersion >= 2;

      if (path === "ping" || (path === "health" && v2)) {
        return this._json(res, 200, v2 ? { ...this.instance, ...this._editorSnapshot() } : this.instance);
      }

      if (path === "queue/cancel" && req.method === "POST" && v2) {
        const { ticketId } = JSON.parse(body || "{}");
        const ticket = this._tickets.get(String(ticketId));
        if (!ticket) return this._json(res, 404, { error: "Ticket not found" });
        let result;
        if (ticket.status === "Queued") {
          ticket.status = "Cancelled";
          ticket.errorMessage = "Cancelled by the client before it started — the command did NOT run.";
          result = { ticketId, cancelled: true, status: "Cancelled" };
        } else {
          result = { ticketId, cancelled: false, status: ticket.status };
        }
        this.cancels.push({ ticketId, result });
        return this._json(res, 200, result);
      }

      if (path === "queue/submit" && req.method === "POST") {
        if (this.mode === "legacy") return this._json(res, 404, { error: "Unknown route" });
        const payload = JSON.parse(body || "{}");
        const route = String(payload.apiPath || "").replace(/^\/?api\//, "").replace(/^\//, "");
        const params = payload.body ? JSON.parse(payload.body) : {};
        this.seen.push({ route, params, headers: req.headers, via: "queue", startTimeoutMs: payload.startTimeoutMs });
        const ticketId = `ticket-${++this._ticketCounter}`;
        // Field names mirror the plugin's MCPRequestQueue.TicketToDict EXACTLY. The failure
        // text lives in `errorMessage` — the mock previously emitted `error`, which is why a
        // 59-test suite never caught the server reading the wrong field for every route.
        const ticket = { ticketId, status: "Queued", agentId: payload.agentId || "unknown", result: null, errorMessage: "" };
        this._tickets.set(ticketId, ticket);
        const complete = () => {
          // A frozen main thread never dequeues anything: the ticket stays Queued.
          if (this.editor.frozen) return;
          if (ticket.status === "Cancelled") return;
          try {
            let outcome = this._resolve(route, params);
            if (outcome && outcome.__logs) {
              // Unity console output captured while the command ran (plugin TicketToDict "logs").
              ticket.logs = outcome.__logs;
              outcome = outcome.__result;
            }
            if (outcome && outcome.__fail) {
              ticket.status = "Failed";
              ticket.errorMessage = outcome.error || "Mock failure";
            } else if (outcome && outcome.__timeout) {
              // Simulate a plugin-side sync-timeout terminal state.
              ticket.status = "TimedOut";
              ticket.errorMessage = outcome.error || "Timed out on the main thread";
            } else if (outcome && outcome.__evict) {
              // Simulate a domain reload evicting the ticket mid-flight: the action ran,
              // but every subsequent status poll 404s (the play-mode false-negative class).
              this._tickets.delete(ticketId);
            } else {
              ticket.status = "Completed";
              ticket.result = outcome;
            }
          } catch (err) {
            ticket.status = "Failed";
            ticket.errorMessage = err.message;
          }
        };
        if (this.holdDialog && !this.editor.frozen) {
          // The command raises a native dialog: it stays Executing until the dialog is answered.
          ticket.status = "Executing";
          this._held = { ticket, route, complete };
          this.editor.dialog = this.holdDialog;
          this.holdDialog = null;
        } else {
          this.processingDelayMs > 0 ? setTimeout(complete, this.processingDelayMs) : complete();
        }
        const accepted = { ticketId, status: "Queued", position: this._tickets.size };
        if (v2) accepted.epoch = this.instance.epoch;
        return this._json(res, 202, accepted);
      }

      if (path === "queue/status") {
        const ticket = this._tickets.get(url.searchParams.get("ticketId"));
        if (!ticket) return this._json(res, 404, v2 ? { error: "Ticket not found", epoch: this.instance.epoch } : { error: "Ticket not found" });
        return this._json(res, 200, v2 ? { ...ticket, editor: this._editorSnapshot() } : ticket);
      }

      if (path === "dialog/click" && req.method === "POST" && this.instance.protocolVersion >= 3) {
        return this._handleDialogClick(res, body);
      }

      if (path === "queue/info") {
        return this._json(res, 200, { totalPending: 0, activeAgents: 0, perAgent: {}, completedCacheSize: this._tickets.size });
      }

      if (path === "context" || path.startsWith("context/")) {
        const category = path === "context" ? null : path.slice("context/".length);
        const ctx = this.contextProvider(category);
        if (ctx === null) return this._json(res, 404, { error: "No project context configured" });
        return this._json(res, 200, ctx);
      }

      // Legacy synchronous execution: POST /api/{route}
      if (req.method === "POST") {
        const params = body ? JSON.parse(body) : {};
        this.seen.push({ route: path, params, headers: req.headers, via: "legacy" });
        const outcome = this._resolve(path, params);
        if (outcome && outcome.__fail) return this._json(res, 200, { success: false, error: outcome.error || "Mock failure" });
        return this._json(res, 200, outcome);
      }

      return this._json(res, 404, { error: `Unknown route: ${path}` });
    });
  }
}
