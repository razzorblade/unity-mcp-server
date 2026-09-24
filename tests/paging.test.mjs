// End-to-end: token-budget paging, console collapse and the objectPath alias, through the
// real server process against the mock bridge.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockBridge } from "./helpers/mock-bridge.mjs";
import { McpTestClient } from "./helpers/mcp-client.mjs";

/** A dense search reply as plugin 2.41 emits it (raw; the Node bridge adds {success, data}). */
function searchReply(groups, rowsPerGroup) {
  const g = {};
  for (let i = 0; i < groups; i++) {
    g[`Level/Area ${i}`] = Array.from({ length: rowsPerGroup }, (_, r) => [`Crate (${r})`, String(-1000 - i * 100 - r)]);
  }
  return { totalFound: groups * rowsPerGroup, columns: ["name", "instanceId"], groupedBy: "parentPath", groups: g };
}

const pageText = (blocks) => blocks.filter((b) => b.type === "text").at(-2).text;
const noticeText = (blocks) => blocks.filter((b) => b.type === "text").at(-1).text;

describe("token-budget paging (UNITY_MCP_MAX_RESPONSE_TOKENS=400)", () => {
  /** @type {MockBridge} */ let bridge;
  /** @type {McpTestClient} */ let client;
  const reply = searchReply(8, 25);

  before(async () => {
    bridge = new MockBridge();
    bridge.on("search/by-name", () => reply);
    bridge.on("console/log", () => ({
      count: 4,
      entries: [
        { message: "boom", type: "error", timestamp: "10:00:01.000", stackTrace: "A:B ()\nC:D ()" },
        { message: "boom", type: "error", timestamp: "10:00:02.000", stackTrace: "A:B ()\nC:D ()" },
        { message: "boom", type: "error", timestamp: "10:00:03.000", stackTrace: "A:B ()\nC:D ()", repeats: 3, firstTimestamp: "09:59:00.000" },
        { message: "hello", type: "log", timestamp: "10:00:04.000", stackTrace: "X:Y ()" },
      ],
    }));
    bridge.on("graphics/renderer-info", (p) => ({ gameObjectPath: p.gameObjectPath ?? null, rendererType: "MeshRenderer" }));
    await bridge.start();
    client = new McpTestClient({ env: { ...bridge.env(), UNITY_MCP_MAX_RESPONSE_TOKENS: "400" } }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await bridge.stop();
  });

  test("an over-budget result arrives as page 1 + a notice; unity_page walks the rest", async () => {
    const { blocks } = await client.callTool("unity_search_by_name", { name: "Crate" });
    const first = JSON.parse(pageText(blocks));
    const notice = noticeText(blocks);
    const m = notice.match(/Page 1\/(\d+) of unity_search_by_name.*"cursor":"([0-9a-f]+)","page":2/);
    assert.ok(m, `notice names the next call: ${notice}`);
    const total = Number(m[1]);
    assert.ok(total > 2, "several pages");
    assert.deepEqual(first.data.columns, ["name", "instanceId"], "page 1 is valid, self-describing JSON");

    const rows = Object.values(first.data.groups).flat();
    for (let n = 2; n <= total; n++) {
      const { blocks: pb, isError } = await client.callTool("unity_page", { cursor: m[2], page: n });
      assert.equal(isError, false);
      const page = JSON.parse(pageText(pb));
      assert.deepEqual(page.data.columns, ["name", "instanceId"], `page ${n} repeats the columns`);
      rows.push(...Object.values(page.data.groups).flat());
      if (n === total) assert.match(noticeText(pb), /last page/);
    }
    assert.equal(rows.length, reply.totalFound, "every row arrives exactly once across the pages");
    assert.equal(bridge.seen.filter((r) => r.route === "search/by-name").length, 1, "paging never re-runs the command in Unity");
  });

  test("an unknown cursor is a clean tool error", async () => {
    const { payload, isError } = await client.callTool("unity_page", { cursor: "00000000", page: 2 });
    assert.equal(isError, true);
    assert.match(payload.error, /Unknown or expired cursor/);
  });

  test("console entries are collapsed server-side (repeat counts add up, time span kept)", async () => {
    const { payload } = await client.callTool("unity_console_log", {});
    const [boom, hello] = payload.data.entries;
    assert.equal(payload.data.entries.length, 2);
    assert.equal(boom.repeats, 5, "1 + 1 + 3 occurrences");
    assert.equal(boom.firstTimestamp, "09:59:00.000");
    assert.equal(boom.timestamp, "10:00:03.000");
    assert.equal(hello.stackTrace, undefined, "non-error traces still stripped");

    const raw = await client.callTool("unity_console_log", { collapse: false });
    assert.equal(raw.payload.data.entries.length, 4, "collapse:false returns every entry");
  });

  test("graphics tools pass objectPath through as gameObjectPath (older plugins read only that)", async () => {
    const { payload } = await client.callTool("unity_advanced_tool", {
      tool: "unity_graphics_renderer_info",
      params: { objectPath: "Level/Orb" },
    });
    assert.equal(payload.data.gameObjectPath, "Level/Orb");
  });

  test("stdout stayed protocol-clean", () => {
    assert.deepEqual(client.stdoutViolations, []);
  });
});

describe("paging disabled (UNITY_MCP_MAX_RESPONSE_TOKENS=0)", () => {
  /** @type {MockBridge} */ let bridge;
  /** @type {McpTestClient} */ let client;

  before(async () => {
    bridge = new MockBridge();
    bridge.on("payload/huge", () => ({ blob: "x".repeat(4_500_000) }));
    await bridge.start();
    client = new McpTestClient({ env: { ...bridge.env(), UNITY_MCP_MAX_RESPONSE_TOKENS: "0" } }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await bridge.stop();
  });

  test("the 4MB hard limit still protects the transport", async () => {
    const { payloadText } = await client.callTool("unity_advanced_tool", { tool: "unity_payload_huge", params: {} });
    assert.ok(payloadText.length < 100_000, `hard limit must shrink the response (got ${payloadText.length} chars)`);
    assert.match(payloadText, /too large/i);
  });
});
