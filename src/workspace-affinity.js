// AnkleBreaker Unity MCP — Workspace ↔ Unity instance affinity
//
// One machine-wide server install serves several editors at once, but every MCP session is
// spawned for a specific workspace (Claude Code starts the server in the project directory and
// can also advertise MCP roots). Matching that workspace against each editor's projectPath lets
// the server pick "this project's editor" on its own, instead of blocking every session behind a
// manual unity_select_instance whenever more than one editor is open.
//
// Pure functions only — discovery and selection state live in instance-discovery.js.

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Filesystems where "C:/Proj" and "c:/proj" are the same directory.
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

/** How deep below a workspace root a Unity project may sit and still count as "this workspace's". */
const MAX_NESTED_DEPTH = 3;

/** Match strength, strongest first. */
export const MATCH = Object.freeze({ NONE: 0, NESTED_PROJECT: 1, INSIDE_PROJECT: 2, EXACT: 3 });

/**
 * Canonical comparable form: forward slashes, no trailing slash, case-folded where the
 * filesystem is case-insensitive.
 * @param {string} path
 * @returns {string}
 */
export function normalizePath(path) {
  if (!path || typeof path !== "string") return "";
  let p = path.trim().replace(/\\/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/**
 * MPPM Virtual Players are clones of the main editor (same productName, projectPath under
 * <project>/Library/VP/). They should never be auto-selected or count as "another editor".
 * @param {{isVirtualPlayer?: boolean, projectPath?: string}} instance
 */
export function isVirtualPlayerInstance(instance) {
  if (!instance) return false;
  if (instance.isVirtualPlayer === true) return true;
  return /\/library\/vp\/[^/]+$/i.test(normalizePath(instance.projectPath));
}

/**
 * Convert MCP roots (file:// URIs) and plain paths into filesystem paths; drops non-file URIs.
 * @param {Array<string|{uri?: string}>} roots
 * @returns {string[]}
 */
export function rootsToPaths(roots) {
  const paths = [];
  for (const root of roots || []) {
    const value = typeof root === "string" ? root : root?.uri;
    if (!value) continue;
    if (/^file:/i.test(value)) {
      try {
        paths.push(fileURLToPath(value));
      } catch {
        // Malformed file URI — ignore it rather than fail discovery.
      }
    } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      paths.push(value);
    }
  }
  return paths;
}

/** A home directory or filesystem root contains everything — too broad to claim nested projects. */
function isTooBroad(normalizedRoot) {
  if (/^([a-z]:)?\/?$/i.test(normalizedRoot)) return true;
  return normalizedRoot === normalizePath(homedir());
}

/**
 * How strongly a workspace root identifies a Unity project.
 * @param {string} projectPath Editor's project root.
 * @param {string} root Workspace directory (cwd, MCP root, or UNITY_PROJECT_PATH).
 * @returns {number} One of MATCH.*.
 */
export function scoreMatch(projectPath, root) {
  const p = normalizePath(projectPath);
  const r = normalizePath(root);
  if (!p || !r) return MATCH.NONE;
  if (p === r) return MATCH.EXACT;
  if (r.startsWith(`${p}/`)) return MATCH.INSIDE_PROJECT; // e.g. cwd = <project>/Assets/Scripts
  if (p.startsWith(`${r}/`) && !isTooBroad(r)) {
    // e.g. monorepo root with the Unity project in a subfolder
    const depth = p.slice(r.length + 1).split("/").length;
    if (depth <= MAX_NESTED_DEPTH) return MATCH.NESTED_PROJECT;
  }
  return MATCH.NONE;
}

/**
 * Pick the single instance that best matches any workspace root. Virtual Players are ignored.
 * Returns null when nothing matches or the best match is ambiguous (two editors equally close).
 * @template {{projectPath?: string, isVirtualPlayer?: boolean}} T
 * @param {T[]} instances
 * @param {string[]} roots
 * @returns {{instance: T, score: number, root: string} | null}
 */
export function pickInstanceForWorkspace(instances, roots) {
  if (!Array.isArray(instances) || !Array.isArray(roots) || roots.length === 0) return null;

  let best = null;
  let tied = false;
  for (const instance of instances) {
    if (isVirtualPlayerInstance(instance)) continue;
    for (const root of roots) {
      const score = scoreMatch(instance.projectPath, root);
      if (score === MATCH.NONE) continue;
      if (!best || score > best.score) {
        best = { instance, score, root };
        tied = false;
      } else if (score === best.score && best.instance !== instance) {
        tied = true;
      }
    }
  }
  return best && !tied ? best : null;
}
