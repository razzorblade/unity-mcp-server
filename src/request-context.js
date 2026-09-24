// AnkleBreaker Unity MCP — Per-request context
//
// The MCP SDK dispatches requests CONCURRENTLY (a new tools/call starts while earlier ones are
// still awaiting Unity). Routing state used to live in module-level variables (port override,
// agent id) that each request set and cleared — so two parallel calls with different `port`
// arguments could send each other's HTTP traffic to the wrong Unity editor.
//
// AsyncLocalStorage scopes that state to one request's async call chain: every await inside a
// tool handler sees its own context, no matter how requests interleave.

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * @typedef {object} RequestContext
 * @property {string} agentId Agent identity sent to the plugin as X-Agent-Id.
 * @property {number|null} port Explicit per-request target port, or null to use the agent's selection.
 * @property {AbortSignal} [signal] Aborted when the MCP client cancels the request.
 * @property {(message: string) => void} [reportProgress] Emits an MCP progress notification (no-op if the client didn't ask).
 */

const storage = new AsyncLocalStorage();

/** @type {RequestContext} */
const DEFAULT_CONTEXT = Object.freeze({ agentId: "default", port: null });

/**
 * Run `fn` with `context` bound to its whole async call chain.
 * @template T
 * @param {RequestContext} context
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithRequestContext(context, fn) {
  return storage.run({ ...DEFAULT_CONTEXT, ...context }, fn);
}

/** @returns {RequestContext} The current request's context (defaults outside a request). */
export function getRequestContext() {
  return storage.getStore() || DEFAULT_CONTEXT;
}

/** True once the MCP client has cancelled the current request. */
export function isRequestCancelled() {
  return getRequestContext().signal?.aborted === true;
}

/**
 * Sleep that wakes early when the client cancels the current request (callers check
 * isRequestCancelled() afterwards).
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  const signal = getRequestContext().signal;
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
