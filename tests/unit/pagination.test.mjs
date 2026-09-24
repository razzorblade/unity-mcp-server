// Token-budget paging: structural splitting, page cache and the unity_page tool.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { splitValue, splitString, paginateText, paginateResult, pageTools, clearPageCache } from "../../src/pagination.js";

const unityPage = pageTools.find((t) => t.name === "unity_page");
const size = (v) => JSON.stringify(v).length;

/**
 * Merge pages back: context repeated on every page (identical values) is kept once; split
 * arrays concatenate; objects merge key-wise (recursively for shared keys).
 */
function mergePages(pages) {
  const merge = (a, b) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return a;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (a && b && typeof a === "object" && typeof b === "object") {
      const out = { ...a };
      for (const [k, v] of Object.entries(b)) out[k] = k in out && typeof v === "object" && v !== null ? merge(out[k], v) : v;
      return out;
    }
    return b;
  };
  return pages.reduce((acc, p) => merge(acc, p));
}

/** A dense search reply: envelope + table grouped by parent path. */
function tableReply(groups, rowsPerGroup) {
  const g = {};
  for (let i = 0; i < groups; i++) {
    g[`Level/Area ${i}/Props`] = Array.from({ length: rowsPerGroup }, (_, r) => [`Crate (${r})`, String(-1000 - i * 100 - r), r % 7 !== 0]);
  }
  return {
    success: true,
    data: { totalFound: groups * rowsPerGroup, columns: ["name", "instanceId", "active"], common: { scene: "Level01" }, groupedBy: "parentPath", groups: g },
  };
}

describe("splitValue", () => {
  test("a value that fits is one page", () => {
    const v = { a: [1, 2, 3] };
    assert.deepEqual(splitValue(v, 1000), [v]);
  });

  test("table replies: every page fits, repeats the context, and pages merge back losslessly", () => {
    const reply = tableReply(12, 40);
    const budget = 2000;
    const pages = splitValue(reply, budget);
    assert.ok(pages.length > 3, `split into several pages (${pages.length})`);
    for (const p of pages) {
      assert.ok(size(p) <= budget, `page fits (${size(p)} > ${budget})`);
      assert.equal(p.success, true, "envelope repeated");
      assert.deepEqual(p.data.columns, ["name", "instanceId", "active"], "columns repeated on every page");
      assert.deepEqual(p.data.common, { scene: "Level01" }, "common repeated on every page");
    }
    assert.deepEqual(mergePages(pages), reply, "concatenating the pages restores the reply");
  });

  test("a single group larger than a page is split across pages under its own key", () => {
    const reply = tableReply(1, 400);
    const pages = splitValue(reply, 1500);
    assert.ok(pages.length > 3);
    for (const p of pages) assert.deepEqual(Object.keys(p.data.groups), ["Level/Area 0/Props"]);
    assert.deepEqual(mergePages(pages), reply);
  });

  test("a deep hierarchy continues under the same node on the next page", () => {
    const leaf = (i) => ({ name: `Wall (${i})`, instanceId: String(-2000 - i), position: [i, 0, i * 2] });
    const reply = { success: true, data: { scene: "S", hierarchy: [{ name: "Level", instanceId: "-1", children: Array.from({ length: 300 }, (_, i) => leaf(i)) }] } };
    const pages = splitValue(reply, 1800);
    assert.ok(pages.length > 3);
    for (const p of pages) {
      assert.ok(size(p) <= 1800);
      assert.equal(p.data.scene, "S");
      assert.equal(p.data.hierarchy.length, 1);
      assert.equal(p.data.hierarchy[0].name, "Level", "the split node keeps its identity on every page");
    }
    const children = pages.flatMap((p) => p.data.hierarchy[0].children);
    assert.deepEqual(children, reply.data.hierarchy[0].children, "every child appears once, in order");
  });

  test("peer objects without a dominant entry are packed across pages", () => {
    const v = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key${i}`, "v".repeat(40)]));
    const pages = splitValue(v, 500);
    assert.ok(pages.length > 3);
    for (const p of pages) assert.ok(size(p) <= 500);
    assert.deepEqual(mergePages(pages), v);
  });

  test("an oversized string is cut into chunks that concatenate back", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const pages = splitValue({ success: true, data: { content: text } }, 800);
    assert.ok(pages.length > 3);
    for (const p of pages) assert.ok(size(p) <= 800 * 1.1);
    assert.equal(pages.map((p) => p.data.content).join(""), text);
  });
});

describe("paginateText", () => {
  test("non-JSON text splits on line boundaries and concatenates back", () => {
    const text = Array.from({ length: 400 }, (_, i) => `row ${i}: ${"x".repeat(i % 30)}`).join("\n");
    const pages = paginateText(text, 1000);
    assert.ok(pages.length > 3);
    for (const p of pages) assert.ok(p.length <= 1000);
    assert.equal(pages.join(""), text);
  });

  test("splitString never cuts mid-line when a newline is near", () => {
    const parts = splitString("aaaa\nbbbb\ncccc\ndddd", 12);
    assert.deepEqual(parts, ["aaaa\nbbbb\n", "cccc\ndddd"]);
  });
});

describe("paginateResult + unity_page", () => {
  const saved = process.env.UNITY_MCP_MAX_RESPONSE_TOKENS;
  beforeEach(() => {
    clearPageCache();
    process.env.UNITY_MCP_MAX_RESPONSE_TOKENS = "400"; // 1000 chars per page
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.UNITY_MCP_MAX_RESPONSE_TOKENS;
    else process.env.UNITY_MCP_MAX_RESPONSE_TOKENS = saved;
  });

  test("results within the budget pass through untouched", () => {
    assert.equal(paginateResult("unity_x", JSON.stringify({ ok: true })), null);
  });

  test("UNITY_MCP_MAX_RESPONSE_TOKENS=0 disables paging", () => {
    process.env.UNITY_MCP_MAX_RESPONSE_TOKENS = "0";
    assert.equal(paginateResult("unity_x", "x".repeat(100_000)), null);
  });

  test("page 1 comes back with a cursor notice; unity_page serves the rest", async () => {
    const reply = tableReply(10, 30);
    const first = paginateResult("unity_search_by_name", JSON.stringify(reply));
    assert.ok(first, "over budget → paged");
    const m = first.notice.match(/"cursor":"([0-9a-f]+)","page":2/);
    assert.ok(m, `notice names the next call: ${first.notice}`);
    assert.match(first.notice, /^\[Page 1\/(\d+) of unity_search_by_name/);
    const total = Number(first.notice.match(/Page 1\/(\d+)/)[1]);

    const pages = [JSON.parse(first.text)];
    for (let n = 2; n <= total; n++) {
      const blocks = await unityPage.handler({ cursor: m[1], page: n });
      pages.push(JSON.parse(blocks[0].text));
      if (n < total) assert.match(blocks[1].text, new RegExp(`"page":${n + 1}`));
      else assert.match(blocks[1].text, /last page/);
    }
    assert.deepEqual(mergePages(pages), reply, "all pages together are the full reply");
  });

  test("unknown cursors and out-of-range pages are errors, not crashes", async () => {
    const bad = JSON.parse(await unityPage.handler({ cursor: "deadbeef", page: 2 }));
    assert.match(bad.error, /Unknown or expired cursor/);

    const first = paginateResult("unity_x", JSON.stringify(tableReply(10, 30)));
    const cursor = first.notice.match(/"cursor":"([0-9a-f]+)"/)[1];
    const out = JSON.parse(await unityPage.handler({ cursor, page: 999 }));
    assert.match(out.error, /page must be an integer from 1 to/);
  });
});
