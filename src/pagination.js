// AnkleBreaker Unity MCP — Response pagination (token budget)
//
// MCP clients cap how much of a tool result reaches the model (Claude Code: 25k tokens by
// default) and silently cut the rest. Rather than let a large result be truncated, a result
// over the budget is split into pages: page 1 is returned now, the rest is cached behind a
// cursor and fetched with unity_page {cursor, page}. Nothing is re-executed in Unity and the
// pages come from one consistent snapshot.
//
// Pages are STRUCTURAL, not byte slices: every page of a JSON result is itself valid JSON with
// the same outer shape. The split follows the data:
//   - an object whose one entry dominates (an envelope, a table, a hierarchy node) repeats its
//     small sibling fields (success, columns, common, name/instanceId, ...) on every page and
//     splits the dominant entry;
//   - peers (array elements, the groups of a table) are packed across pages in order;
//   - an element too large for any page is split recursively the same way, so a deep node
//     continues on the next page under its own name;
//   - an oversized string is cut at line boundaries; non-JSON text is split by lines.
// Concatenating the pages' lists/objects in page order restores the full result.

import { randomBytes } from "crypto";

/** Default page budget in tokens. UNITY_MCP_MAX_RESPONSE_TOKENS overrides; 0 disables paging. */
export const DEFAULT_BUDGET_TOKENS = 20000;

// Conservative characters-per-token for the compact JSON these tools emit (measured 2.6-3.1
// with Claude's tokenizer on real payloads). Lower = smaller pages = safer.
const CHARS_PER_TOKEN = 2.5;

const CACHE_MAX_ENTRIES = 16;
const CACHE_TTL_MS = 15 * 60 * 1000;

function readBudgetTokens() {
  const raw = process.env.UNITY_MCP_MAX_RESPONSE_TOKENS;
  if (raw === undefined || raw === "") return DEFAULT_BUDGET_TOKENS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUDGET_TOKENS;
}

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

// ─── Structural splitting ───

const isContainer = (v) => v !== null && typeof v === "object";

/**
 * Split a JSON value into parts whose compact serialization fits `budget` characters.
 * Each part has the same shape as `value` (same container type, same repeated context).
 * @param {*} value
 * @param {number} budget
 * @returns {Array<*>}
 */
export function splitValue(value, budget) {
  const size = (v) => JSON.stringify(v).length;
  // Never recurse below this: the payload of a page must be able to carry some content.
  const floor = 64;

  function split(v, b) {
    const total = size(v);
    if (total <= b) return [v];
    if (typeof v === "string") return splitJsonString(v, Math.max(floor, b));
    if (!isContainer(v)) return [v]; // an oversized scalar can't be split
    return Array.isArray(v) ? splitArray(v, b) : splitObject(v, b, total);
  }

  function splitArray(arr, b) {
    const parts = [];
    let current = [];
    let used = 2; // []
    const flush = () => {
      if (current.length) parts.push(current);
      current = [];
      used = 2;
    };
    for (const item of arr) {
      const s = size(item);
      if (s + 2 > b) {
        // Too big for any page: flush, then give each fragment of the item its own part.
        flush();
        for (const piece of split(item, Math.max(floor, b - 2))) parts.push([piece]);
        continue;
      }
      if (used + s + (current.length ? 1 : 0) > b) flush();
      used += s + (current.length ? 1 : 0);
      current.push(item);
    }
    flush();
    return parts;
  }

  function splitObject(obj, b, total) {
    const entries = Object.entries(obj);
    let heaviest = null;
    let heaviestSize = -1;
    for (const [k, v] of entries) {
      const s = size(v);
      if (s > heaviestSize) {
        heaviest = k;
        heaviestSize = s;
      }
    }

    // Dominant entry: repeat the (small) rest on every page, split the dominant value.
    const contextSize = total - heaviestSize;
    if (isContainer(obj[heaviest]) || typeof obj[heaviest] === "string") {
      if (heaviestSize >= total / 2 && contextSize <= b / 4) {
        const room = Math.max(floor, b - contextSize);
        return split(obj[heaviest], room).map((piece) => ({ ...obj, [heaviest]: piece }));
      }
    }

    // Peers: pack entries in order across pages; split an oversized entry on its own.
    const parts = [];
    let current = {};
    let used = 2; // {}
    let count = 0;
    const flush = () => {
      if (count) parts.push(current);
      current = {};
      used = 2;
      count = 0;
    };
    for (const [k, v] of entries) {
      const keyCost = JSON.stringify(k).length + 1; // "key":
      const s = keyCost + size(v);
      if (s + 2 > b) {
        flush();
        for (const piece of split(v, Math.max(floor, b - keyCost - 2))) parts.push({ [k]: piece });
        continue;
      }
      if (used + s + (count ? 1 : 0) > b) flush();
      used += s + (count ? 1 : 0);
      current[k] = v;
      count++;
    }
    flush();
    return parts;
  }

  return split(value, budget);
}

/**
 * Cut a string so each chunk's JSON serialization (quotes + escapes: a newline costs 2 chars)
 * fits `budget`. Sized from the string's escape ratio, then any chunk still over is re-cut.
 */
function splitJsonString(text, budget) {
  const ratio = JSON.stringify(text).length / Math.max(1, text.length);
  const out = [];
  for (const chunk of splitString(text, Math.max(16, Math.floor((budget - 2) / ratio)))) {
    if (JSON.stringify(chunk).length <= budget || chunk.length <= 16) out.push(chunk);
    else out.push(...splitJsonString(chunk, budget));
  }
  return out;
}

/** Cut text into chunks of at most `budget` chars, preferring line boundaries. */
export function splitString(text, budget) {
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + budget);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline > start + budget / 2) end = newline + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * Split a tool's text result into pages that each fit the budget.
 * @param {string} text
 * @param {number} budgetChars
 * @returns {string[]} one page when it already fits
 */
export function paginateText(text, budgetChars) {
  if (text.length <= budgetChars) return [text];
  const first = text[0];
  if (first === "{" || first === "[") {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      const pages = splitValue(parsed, budgetChars).map((p) => JSON.stringify(p));
      // Structural paging can only fail on a single oversized scalar; fall back to lines then.
      if (pages.length > 1 && pages.every((p) => p.length <= budgetChars * 1.1)) return pages;
    }
  }
  return splitString(text, budgetChars);
}

// ─── Page cache ───

const cache = new Map(); // cursor → { pages, tool, totalTokens, createdAt }

function remember(tool, pages, totalTokens) {
  const now = Date.now();
  for (const [cursor, entry] of cache) if (now - entry.createdAt > CACHE_TTL_MS) cache.delete(cursor);
  while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value); // oldest first
  const cursor = randomBytes(4).toString("hex");
  cache.set(cursor, { pages, tool, totalTokens, createdAt: now });
  return cursor;
}

function pageNotice(cursor, page, pages, tool, totalTokens) {
  if (page >= pages.length) {
    return `[Page ${page}/${pages.length} of ${tool} — last page.]`;
  }
  return (
    `[Page ${page}/${pages.length} of ${tool} (~${Math.round(totalTokens / 1000)}k tokens in total). ` +
    `Next: unity_page {"cursor":"${cursor}","page":${page + 1}}. Each page has the same outer structure ` +
    `(its lists/objects continue on the next page). A narrower query (limit, filter, parentPath, maxDepth) avoids paging.]`
  );
}

/**
 * Apply the token budget to a tool's text result.
 * @param {string} tool Tool name (for the notice).
 * @param {string} text Full result text.
 * @returns {{ text: string, notice: string } | null} null when the result fits (or paging is off).
 */
export function paginateResult(tool, text) {
  const budgetTokens = readBudgetTokens();
  if (!budgetTokens || typeof text !== "string") return null;
  const budgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN);
  if (text.length <= budgetChars) return null;

  const pages = paginateText(text, budgetChars);
  if (pages.length <= 1) return null;
  const totalTokens = estimateTokens(text);
  const cursor = remember(tool, pages, totalTokens);
  return { text: pages[0], notice: pageNotice(cursor, 1, pages, tool, totalTokens) };
}

/** Test hook: drop every cached result. */
export function clearPageCache() {
  cache.clear();
}

// ─── unity_page tool ───

export const pageTools = [
  {
    name: "unity_page",
    description:
      "Fetch another page of a large tool result, using the cursor from its page notice.",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string" },
        page: { type: "number", description: "1-based" },
      },
      required: ["cursor", "page"],
    },
    handler: async ({ cursor, page } = {}) => {
      const entry = cache.get(String(cursor));
      if (!entry || Date.now() - entry.createdAt > CACHE_TTL_MS) {
        cache.delete(String(cursor));
        return JSON.stringify({
          error: `Unknown or expired cursor '${cursor}'. Pages are kept for ${CACHE_TTL_MS / 60000} minutes (last ${CACHE_MAX_ENTRIES} results); re-run the original tool.`,
        });
      }
      const n = Number(page);
      if (!Number.isInteger(n) || n < 1 || n > entry.pages.length) {
        return JSON.stringify({ error: `page must be an integer from 1 to ${entry.pages.length}.` });
      }
      return [
        { type: "text", text: entry.pages[n - 1] },
        { type: "text", text: pageNotice(cursor, n, entry.pages, entry.tool, entry.totalTokens) },
      ];
    },
  },
];
