// Unity MCP — Multi-Instance Discovery
// Discovers running Unity Editor instances via:
//   1. Shared registry file (%LOCALAPPDATA%/UnityMCP/instances.json)
//   2. Port scanning fallback (7890-7899)
//
// Also manages instance selection state and picks this workspace's editor automatically.

import { readFileSync } from "fs";
import { delimiter } from "path";
import { CONFIG } from "./config.js";
import { debugLog } from "./state-persistence.js";
import { getRequestContext } from "./request-context.js";
import { isVirtualPlayerInstance, pickInstanceForWorkspace, MATCH } from "./workspace-affinity.js";

// ─── Per-Agent Session State ───
// Tracks which Unity instance each agent is targeting, keyed by agent id: a single MCP process
// can serve several agents (per-request _meta.agentId), and Agent A selecting ProjectA must not
// reroute Agent B. The agent id and any per-request `port` come from the request context
// (AsyncLocalStorage), so concurrent requests never see each other's routing.
const _agentInstances = new Map();          // agentId → instance
const _agentSelectionRequired = new Map();  // agentId → boolean

// Latest metadata per port (protocolVersion etc.), for requests routed by explicit port.
const _instancesByPort = new Map();

/**
 * Workspace roots in priority tiers — an explicit UNITY_PROJECT_PATH outranks MCP roots, which
 * outrank the process cwd. Replaced by index.js once the client's MCP roots are known.
 * @type {() => Promise<string[][]>}
 */
let _workspaceRootsProvider = async () => defaultWorkspaceRootTiers();

/**
 * Workspace root tiers: [UNITY_PROJECT_PATH entries], [client MCP roots], [cwd].
 * @param {string[]} [clientRoots] Paths from the client's roots/list.
 */
export function defaultWorkspaceRootTiers(clientRoots = []) {
  const explicit = (process.env.UNITY_PROJECT_PATH || "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
  return [explicit, clientRoots, [process.cwd()]].filter((tier) => tier.length > 0);
}

/**
 * Install the workspace-roots source used for automatic instance selection.
 * @param {() => Promise<string[][]>} provider Returns root paths grouped in priority tiers.
 */
export function setWorkspaceRootsProvider(provider) {
  _workspaceRootsProvider = provider;
}

function currentAgentId() {
  return getRequestContext().agentId || "default";
}

/**
 * Get the currently selected Unity instance for the current agent.
 * @returns {object|null} Selected instance info, or null if none selected.
 */
export function getSelectedInstance() {
  return _agentInstances.get(currentAgentId()) || null;
}

/**
 * Metadata of the instance the current request will talk to (explicit port → agent selection →
 * default port), or null when unknown. Used for capability gating (protocolVersion).
 */
export function getActiveInstance() {
  const ctx = getRequestContext();
  if (ctx.port != null) return _instancesByPort.get(ctx.port) || null;
  return _agentInstances.get(currentAgentId()) || _instancesByPort.get(CONFIG.editorBridgePort) || null;
}

function rememberInstance(instance) {
  if (instance && instance.port) _instancesByPort.set(instance.port, instance);
}

function selectForCurrentAgent(instance) {
  _agentInstances.set(currentAgentId(), instance);
  _agentSelectionRequired.set(currentAgentId(), false);
  rememberInstance(instance);
}

/**
 * Validate that the currently selected instance is still alive and hosts the expected project.
 * Called on each tool execution to catch cases where Unity was closed or the port changed.
 *
 * Compile-time resilience:
 *   During a domain reload the HTTP bridge is down, so it can't respond. We use the instance
 *   registry file (persists across reloads) as a secondary signal. If a port is unresponsive but
 *   the registry still claims our project is on that port, we keep the selection — Unity is
 *   likely reloading. We only clear the selection when we have positive evidence the project is
 *   gone (not in registry AND not responding).
 *
 * @returns {object|null} Validated instance, or null if validation cleared the selection.
 */
export async function validateSelectedInstance() {
  const agentId = currentAgentId();
  const saved = _agentInstances.get(agentId);
  if (!saved) return null;

  const savedPath = saved.projectPath;
  const savedPort = saved.port;

  // One request answers both "alive?" and "which project?" (it used to be two).
  const info = await getInstanceInfo(savedPort);
  if (info) {
    if (info.projectPath && info.projectPath === savedPath) {
      const refreshed = { ...saved, ...definedFields(info) };
      _agentInstances.set(agentId, refreshed);
      rememberInstance(refreshed);
      return refreshed;
    }

    if (info.projectPath) {
      // PORT SWAP DETECTED: a different project is on the saved port
      debugLog(`⚠ Port swap detected! Port ${savedPort} now hosts "${info.projectName}" (expected "${saved.projectName}")`);
      console.error(
        `[MCP Discovery] Port swap detected: port ${savedPort} now hosts "${info.projectName}" instead of "${saved.projectName}". Re-discovering...`
      );
    }
    // Fall through to re-discovery (swap or info unavailable)
  } else {
    // Port not responding — could be a domain reload, could be shut down.
    // Check the registry file as a secondary signal before assuming the worst.
    const registryMatch = readRegistryFile().find(
      (entry) => entry.port === savedPort && entry.projectPath && entry.projectPath === savedPath
    );

    if (registryMatch) {
      if (isRegistryEntryStale(registryMatch)) {
        debugLog(
          `Port ${savedPort} unresponsive and registry entry is STALE (lastSeen: ${registryMatch.lastSeen}). Unity likely crashed. Proceeding to re-discovery.`
        );
      } else {
        debugLog(`Port ${savedPort} unresponsive but registry entry is fresh — likely reloading. Keeping selection.`);
        return saved;
      }
    }

    debugLog(`Port ${savedPort} unresponsive and not in registry — re-discovering...`);
  }

  // Re-discover all instances and find the one matching our saved projectPath
  const instances = await discoverInstances();
  const match = instances.find((inst) => inst.projectPath && inst.projectPath === savedPath);

  if (match) {
    debugLog(`Re-selected ${saved.projectName} on new port ${match.port} (was ${savedPort})`);
    selectForCurrentAgent(match);
    return match;
  }

  // Last resort: check if the registry has our project on ANY port (could be reloading on a new port)
  const registryFallback = readRegistryFile().find(
    (entry) => entry.projectPath && entry.projectPath === savedPath
  );
  if (registryFallback && registryFallback.port) {
    if (isRegistryEntryStale(registryFallback)) {
      debugLog(`Project "${saved.projectName}" found in registry but entry is STALE. Clearing selection.`);
    } else {
      debugLog(
        `Project "${saved.projectName}" found in registry on port ${registryFallback.port} (fresh) — likely reloading. Keeping selection.`
      );
      const updated = { ...saved, port: registryFallback.port };
      _agentInstances.set(agentId, updated);
      return updated;
    }
  }

  // Project truly gone — not responding AND not in registry.
  // FAIL CLOSED: this agent explicitly had a project selected and that project vanished.
  // Falling through to the default port would, in any multi-project session, hit a DIFFERENT
  // live Unity — a write intended for project A silently landing in project B. Require an
  // explicit re-selection instead.
  debugLog(`Project "${saved.projectName}" no longer found. Clearing selection for agent ${agentId} and requiring re-selection.`);
  _agentInstances.delete(agentId);
  _agentSelectionRequired.set(agentId, true);
  return null;
}

/**
 * Check whether the session still needs the user to select an instance.
 */
export function isInstanceSelectionRequired() {
  return _agentSelectionRequired.get(currentAgentId()) || false;
}

/**
 * Select a Unity instance by port number.
 * All subsequent bridge commands will be routed to this port.
 * @param {number} port - The port of the instance to select.
 * @returns {object} The selected instance info, or error.
 */
export async function selectInstance(port) {
  const instances = await discoverInstances();
  const match = instances.find((inst) => inst.port === port);

  if (!match) {
    return {
      success: false,
      error: `No Unity instance found on port ${port}. Use unity_list_instances to see available instances.`,
    };
  }

  selectForCurrentAgent(match);
  debugLog(`selectInstance: agent ${currentAgentId()} selected port ${port} (${match.projectName})`);

  return {
    success: true,
    message: `Selected Unity instance: ${match.projectName} (port ${port})`,
    instance: match,
  };
}

/**
 * Get the bridge URL for the current request.
 * Priority: per-request port > per-agent selection > default CONFIG port.
 * @returns {string} The base URL for HTTP bridge commands.
 */
export function getActiveBridgeUrl() {
  const host = CONFIG.editorBridgeHost;
  const ctx = getRequestContext();
  if (ctx.port != null) return `http://${host}:${ctx.port}`;
  const selected = _agentInstances.get(currentAgentId());
  if (selected) return `http://${host}:${selected.port}`;
  return `http://${host}:${CONFIG.editorBridgePort}`;
}

/**
 * Discover all running Unity instances.
 * Reads the shared registry file first, then validates each entry is alive.
 * Falls back to port scanning for instances not in the registry.
 *
 * @returns {Promise<Array<object>>} Discovered instances with their metadata.
 */
export async function discoverInstances() {
  let instances = [];

  // Step 1: Read registry file, validating each entry with one ping (which also carries the
  // capability handshake and the live-state fields).
  try {
    const registryData = readRegistryFile();
    if (registryData.length > 0) {
      const validated = await Promise.all(
        registryData.map(async (entry) => {
          if (!entry.port) return null;
          const info = await getInstanceInfo(entry.port);
          if (info === null) return null;
          return { ...entry, ...definedFields(info), alive: true, source: "registry" };
        })
      );
      instances = validated.filter((inst) => inst !== null);
    }
  } catch (err) {
    console.error(`[MCP Discovery] Error reading registry: ${err.message}`);
  }

  // Step 2: Port scan fallback (find instances not in registry)
  const registeredPorts = new Set(instances.map((i) => i.port));
  const scanPromises = [];
  for (let port = CONFIG.portRangeStart; port <= CONFIG.portRangeEnd; port++) {
    if (registeredPorts.has(port)) continue;
    scanPromises.push(
      getInstanceInfo(port).then((info) => (info ? fromPing(port, info, "portscan") : null))
    );
  }

  for (const inst of await Promise.all(scanPromises)) {
    if (inst) instances.push(inst);
  }

  for (const inst of instances) rememberInstance(inst);
  return instances;
}

/**
 * Auto-select an instance for the current agent when the choice is unambiguous:
 *   - exactly one editor is running (MPPM Virtual Players don't count), or
 *   - exactly one editor belongs to this session's workspace (UNITY_PROJECT_PATH, MCP roots, cwd).
 * Otherwise marks selection as required. With no instances, tries the default port.
 * @returns {Promise<object>} { autoSelected, instance?, instances, reason?, message }
 */
export async function autoSelectInstance() {
  const agentId = currentAgentId();
  const instances = await discoverInstances();

  if (instances.length === 0) {
    // No instances found — try default port as last resort
    const info = await getInstanceInfo(CONFIG.editorBridgePort);
    if (info) {
      const defaultInstance = fromPing(CONFIG.editorBridgePort, info, "default");
      selectForCurrentAgent(defaultInstance);
      debugLog(`autoSelect: agent ${agentId} → single default instance on port ${CONFIG.editorBridgePort}`);
      return {
        autoSelected: true,
        instance: defaultInstance,
        instances: [defaultInstance],
        reason: "only running editor",
        message: `Auto-connected to Unity Editor: ${defaultInstance.projectName} (port ${CONFIG.editorBridgePort})`,
      };
    }

    _agentSelectionRequired.set(agentId, false);
    return {
      autoSelected: false,
      instances: [],
      message: "No Unity Editor instances found. Make sure Unity is running with the MCP plugin enabled.",
    };
  }

  // Virtual Players are clones of an editor that is also running; they never make the choice
  // ambiguous. (Only when nothing but Virtual Players is visible do they remain candidates.)
  const editors = instances.filter((inst) => !isVirtualPlayerInstance(inst));
  const candidates = editors.length > 0 ? editors : instances;

  if (candidates.length === 1) {
    const only = candidates[0];
    selectForCurrentAgent(only);
    debugLog(`autoSelect: agent ${agentId} → single editor on port ${only.port}`);
    return {
      autoSelected: true,
      instance: only,
      instances,
      reason: instances.length > 1 ? "only running editor (Multiplayer Play Mode virtual players ignored)" : "only running editor",
      message: `Auto-connected to Unity Editor: ${only.projectName} (port ${only.port})`,
    };
  }

  // Several editors: pick the one belonging to this session's workspace, tier by tier.
  const match = await matchWorkspace(candidates);
  if (match) {
    selectForCurrentAgent(match.instance);
    debugLog(`autoSelect: agent ${agentId} → workspace match "${match.root}" → port ${match.instance.port}`);
    return {
      autoSelected: true,
      instance: match.instance,
      instances,
      reason: `matches this session's workspace (${match.root})`,
      message: `Auto-connected to Unity Editor: ${match.instance.projectName} (port ${match.instance.port})`,
    };
  }

  // Multiple instances — require user selection (but only if none already selected for this agent)
  if (!_agentInstances.get(agentId)) {
    _agentSelectionRequired.set(agentId, true);
    debugLog(`autoSelect: agent ${agentId} → ${candidates.length} editors found, no workspace match, selection required`);
  }
  return {
    autoSelected: false,
    instances,
    message: `Found ${candidates.length} Unity Editor instances. Please use unity_select_instance to choose which one to work with.`,
  };
}

/** First priority tier with an unambiguous workspace match wins. */
async function matchWorkspace(candidates) {
  let tiers = [];
  try {
    tiers = await _workspaceRootsProvider();
  } catch (err) {
    debugLog(`Workspace roots unavailable: ${err.message}`);
  }
  for (const tier of tiers) {
    const pick = pickInstanceForWorkspace(candidates, tier);
    if (pick && pick.score >= MATCH.NESTED_PROJECT) return pick;
  }
  return null;
}

// ─── Internal helpers ───

/** Standard instance object from a ping payload. */
function fromPing(port, info, source) {
  return {
    port,
    projectName: info.projectName || `Unknown (port ${port})`,
    projectPath: info.projectPath || "",
    unityVersion: info.unityVersion || "",
    isClone: info.isClone || false,
    cloneIndex: info.cloneIndex ?? -1,
    ...definedFields(info),
    alive: true,
    source,
  };
}

/** Copy only the fields a ping actually reported, so registry data isn't blanked by gaps. */
function definedFields(info) {
  const out = {};
  for (const [key, value] of Object.entries(info)) {
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/**
 * Check if a registry entry is stale (Unity likely crashed).
 * The plugin updates `lastSeen` every ~30s via a heartbeat. If the entry's
 * lastSeen timestamp is older than the staleness timeout, Unity likely crashed
 * without calling OnDisable (which would have cleaned up the entry).
 *
 * If the entry has no `lastSeen` field (old plugin version), we fall back to
 * `registeredAt`. If neither is present, we treat it as stale (no way to verify).
 *
 * @param {object} entry - A registry entry object.
 * @returns {boolean} True if the entry is considered stale.
 */
function isRegistryEntryStale(entry) {
  const timestamp = entry.lastSeen || entry.registeredAt;
  if (!timestamp) return true;

  const entryTime = new Date(timestamp).getTime();
  if (isNaN(entryTime)) return true;

  const ageMs = Date.now() - entryTime;
  const isStale = ageMs > CONFIG.registryStalenessTimeoutMs;
  if (isStale) {
    debugLog(
      `Registry entry staleness check: age=${Math.round(ageMs / 60000)}min, threshold=${CONFIG.registryStalenessTimeoutMs / 60000}min → STALE`
    );
  }
  return isStale;
}

/**
 * Read the instance registry file.
 * @returns {Array<object>} Parsed instance entries.
 */
function readRegistryFile() {
  try {
    const data = JSON.parse(readFileSync(CONFIG.instanceRegistryPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    // File doesn't exist or can't be parsed — that's fine
    return [];
  }
}

/**
 * Identity + live state of the Unity instance on a port, or null if nothing answers.
 * Plugins >= protocolVersion 2 answer off the main thread, so a busy editor still responds.
 * @param {number} port
 * @returns {Promise<object|null>}
 */
export async function getInstanceInfo(port) {
  try {
    const response = await fetch(`http://${CONFIG.editorBridgeHost}:${port}/api/ping`, {
      method: "GET",
      signal: AbortSignal.timeout(CONFIG.discoveryPingTimeoutMs),
    });
    if (!response.ok) return null;

    const data = await response.json();
    const live =
      typeof data.mainThreadStallMs === "number"
        ? {
            busy: data.busy === true,
            busyReason: data.busyReason ?? null,
            mainThreadStallMs: data.mainThreadStallMs,
            isPlaying: data.isPlaying === true,
            isCompiling: data.isCompiling === true,
          }
        : undefined;
    return {
      live,
      projectName: data.projectName || data.project || undefined,
      projectPath: data.projectPath || undefined,
      unityVersion: data.unityVersion || data.version || undefined,
      isClone: typeof data.isClone === "boolean" ? data.isClone : undefined,
      cloneIndex: typeof data.cloneIndex === "number" ? data.cloneIndex : undefined,
      isVirtualPlayer: typeof data.isVirtualPlayer === "boolean" ? data.isVirtualPlayer : undefined,
      mainProjectPath: data.mainProjectPath || undefined,
      // Capability handshake fields (plugins >= protocolVersion 1; else undefined)
      protocolVersion: typeof data.protocolVersion === "number" ? data.protocolVersion : undefined,
      pluginVersion: typeof data.pluginVersion === "string" ? data.pluginVersion : undefined,
      epoch: typeof data.epoch === "string" ? data.epoch : undefined,
    };
  } catch {
    return null;
  }
}
