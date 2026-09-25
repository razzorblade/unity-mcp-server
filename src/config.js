// AnkleBreaker Unity MCP — Configuration
// Adjust these paths to match your Unity installation

import { homedir } from "os";
import { join } from "path";

// Determine the instance registry path based on platform
function getRegistryPath() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "UnityMCP", "instances.json");
  }
  // macOS / Linux
  return join(homedir(), ".local", "share", "UnityMCP", "instances.json");
}

export const CONFIG = {
  // Unity Hub
  unityHubPath: process.env.UNITY_HUB_PATH || "C:\\Program Files\\Unity Hub\\Unity Hub.exe",

  // Unity Editor Bridge (default — used as fallback when no instance is selected)
  editorBridgeHost: process.env.UNITY_BRIDGE_HOST || "127.0.0.1",
  editorBridgePort: parseInt(process.env.UNITY_BRIDGE_PORT || "7890"),
  editorBridgeTimeout: parseInt(process.env.UNITY_BRIDGE_TIMEOUT || "60000"),

  // Multi-instance support
  portRangeStart: parseInt(process.env.UNITY_PORT_RANGE_START || "7890"),
  portRangeEnd: parseInt(process.env.UNITY_PORT_RANGE_END || "7899"),
  instanceRegistryPath: process.env.UNITY_INSTANCE_REGISTRY || getRegistryPath(),

  // Discovery / validation ping. Plugins >= protocolVersion 2 answer ping off the main thread,
  // so this only has to cover loopback latency, not a busy editor.
  discoveryPingTimeoutMs: parseInt(process.env.UNITY_DISCOVERY_PING_TIMEOUT || "2000"),

  // Queue mode polling (for async ticket-based requests)
  queuePollIntervalMs: parseInt(process.env.UNITY_QUEUE_POLL_INTERVAL || "150"),
  queuePollMaxMs: parseInt(process.env.UNITY_QUEUE_POLL_MAX || "1500"),
  queuePollTimeoutMs: parseInt(process.env.UNITY_QUEUE_POLL_TIMEOUT || "120000"), // Max total wait per command (2 min)

  // queue/submit only enqueues on the plugin (no main-thread work), so it answers in
  // milliseconds; a submit that takes longer means the bridge is wedged. Fail fast.
  queueSubmitTimeoutMs: parseInt(process.env.UNITY_QUEUE_SUBMIT_TIMEOUT || "10000"),

  // A command still QUEUED while Unity's main thread has not ticked for this long is cancelled
  // and reported instead of waited on (modal dialog, frozen editor, throttled MPPM session).
  // Compiling/importing gets 3x this, since those stalls are expected to end on their own.
  mainThreadStallTimeoutMs: parseInt(process.env.UNITY_MAIN_THREAD_STALL_TIMEOUT || "20000"),

  // Routes that legitimately run longer than queuePollTimeoutMs.
  routeTimeoutsMs: {
    "build/start": parseInt(process.env.UNITY_BUILD_TIMEOUT || "1800000"), // 30 min
    "packages/add": 300000,
    "packages/remove": 300000,
    "asset/refresh": 300000, // a large import can outlast the default wait
  },

  // Default Unity Editor path pattern (version will be interpolated)
  editorPathPattern: process.env.UNITY_EDITOR_PATH || "C:\\Program Files\\Unity\\Hub\\Editor\\{version}\\Editor\\Unity.exe",

  // Registry staleness timeout (ms) — if a registry entry's lastSeen timestamp is older
  // than this AND the port is unresponsive, the entry is considered stale (Unity likely crashed).
  // The plugin sends a heartbeat every 30s, so 5 minutes gives plenty of margin.
  registryStalenessTimeoutMs: parseInt(process.env.UNITY_REGISTRY_STALENESS_TIMEOUT || "300000"), // 5 minutes

  // Response size limits (bytes) — protects against Write EOF errors on large projects
  // Soft limit: log a warning but still return the response
  responseSoftLimitBytes: parseInt(process.env.UNITY_RESPONSE_SOFT_LIMIT || String(2 * 1024 * 1024)),   // 2 MB
  // Hard limit: truncate the response and return pagination guidance instead
  responseHardLimitBytes: parseInt(process.env.UNITY_RESPONSE_HARD_LIMIT || String(4 * 1024 * 1024)),   // 4 MB

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",
};
