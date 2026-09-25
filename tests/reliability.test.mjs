// Reliability tests — the failure modes that used to leave agents hanging or guessing:
//   * a frozen Unity main thread (modal dialog, throttled Multiplayer Play Mode session)
//   * client cancellation of a pending command
//   * "successful" calls whose Unity console says otherwise
//   * concurrent calls routed to different editors
//   * one server shared by several editors (workspace affinity, MPPM virtual players)
//   * lightmap bakes that must end in a definite state
// Spawns the real MCP server over stdio against mock Unity bridges.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockBridge } from "./helpers/mock-bridge.mjs";
import { McpTestClient } from "./helpers/mcp-client.mjs";

/** Registry file advertising the given bridges (discovery reads it before port scanning). */
function writeRegistry(bridges) {
  const dir = mkdtempSync(join(tmpdir(), "umcp-registry-"));
  const registryPath = join(dir, "instances.json");
  const now = new Date().toISOString();
  writeFileSync(
    registryPath,
    JSON.stringify(
      bridges.map((b) => ({
        port: b.port,
        projectName: b.instance.projectName,
        projectPath: b.instance.projectPath,
        unityVersion: b.instance.unityVersion,
        isVirtualPlayer: b.instance.isVirtualPlayer === true,
        lastSeen: now,
      }))
    )
  );
  return registryPath;
}

/** Forward-slash path, as the Unity plugin reports projectPath. */
const unityPath = (p) => p.replace(/\\/g, "/");

async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

describe("main-thread stall detection (issue: commands hanging on a frozen editor)", () => {
  /** @type {MockBridge} */ let bridge;
  /** @type {McpTestClient} */ let client;

  before(async () => {
    bridge = new MockBridge();
    await bridge.start();
    client = new McpTestClient({
      env: { ...bridge.env(), UNITY_MAIN_THREAD_STALL_TIMEOUT: "400", UNITY_QUEUE_POLL_TIMEOUT: "3000" },
    }).start();
    await client.initialize();
    await client.callTool("unity_editor_state"); // discovery + context banner out of the way
  });

  after(async () => {
    await client.close();
    await bridge.stop();
  });

  test("a queued command behind a frozen main thread is cancelled and reported as not executed", async () => {
    bridge.editor = { mainThreadStallMs: 45_000, busy: true, busyReason: "main thread blocked (modal dialog)", executing: null, frozen: true };
    bridge.cancels = [];
    const started = Date.now();
    const { payload, isError } = await client.callTool("unity_scene_info");
    const elapsed = Date.now() - started;

    assert.equal(isError, true);
    assert.equal(payload.executed, "no", "cancelled before start → did not run");
    assert.match(payload.error, /has not responded for 45s/);
    assert.match(payload.error, /modal dialog/);
    assert.match(payload.error, /did NOT run/);
    assert.equal(bridge.cancels.length, 1, "the ticket was cancelled on the plugin");
    assert.ok(elapsed < 2500, `failed fast (${elapsed}ms), not after the full poll timeout`);
  });

  test("a stall caused by another MCP command executing is waited on, not cancelled early", async () => {
    bridge.editor = { mainThreadStallMs: 45_000, busy: true, busyReason: "executing MCP command 'editor/execute-code'", executing: "editor/execute-code", frozen: true };
    bridge.cancels = [];
    const started = Date.now();
    const { payload, isError } = await client.callTool("unity_scene_info");

    assert.equal(isError, true);
    assert.match(payload.error, /No result from Unity after \d+s \(still waiting to start\)/);
    assert.equal(payload.executed, "no", "still queued at the deadline → cancelled → did not run");
    assert.ok(Date.now() - started >= 2500, "waited for the deadline instead of the stall threshold");
  });

  test("submit tells the plugin when to drop the ticket unexecuted", async () => {
    bridge.editor = { mainThreadStallMs: 0, busy: false, busyReason: null, executing: null, frozen: false };
    await client.callTool("unity_scene_info");
    const last = bridge.seen.filter((r) => r.route === "scene/info").at(-1);
    assert.ok(last.startTimeoutMs > 0 && last.startTimeoutMs <= 3000, `startTimeoutMs=${last.startTimeoutMs}`);
  });

  test("client cancellation cancels the pending Unity ticket", async () => {
    bridge.editor = { mainThreadStallMs: 100, busy: false, busyReason: null, executing: null, frozen: true };
    bridge.cancels = [];
    const submittedBefore = bridge.seen.length;
    const requestId = client.sendToolCallNoWait("unity_scene_info");
    // Cancel only once THIS call's ticket exists in Unity (earlier cancels never reach Unity at all).
    assert.ok(await waitFor(() => bridge.seen.length > submittedBefore), "ticket submitted");
    client.notify("notifications/cancelled", { requestId, reason: "user pressed Esc" });
    assert.ok(await waitFor(() => bridge.cancels.length === 1), "queue/cancel was sent");
    assert.equal(bridge.cancels[0].result.cancelled, true);
    bridge.editor.frozen = false;
  });
});

describe("Unity console capture (issue: 'success' that did nothing)", () => {
  /** @type {MockBridge} */ let bridge;
  /** @type {McpTestClient} */ let client;

  before(async () => {
    bridge = new MockBridge();
    bridge.on("editor/execute-code", () => ({
      __logs: [{ type: "Error", message: "Lightmapping failed: scene has no Lighting Settings" }],
      __result: { success: true, result: null },
    }));
    bridge.on("scene/info", () => ({
      __logs: [{ type: "Warning", message: "Something mildly odd" }],
      __result: { name: "Main" },
    }));
    await bridge.start();
    client = new McpTestClient({ env: bridge.env() }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await bridge.stop();
  });

  test("errors Unity logged during the command are attached with a warning", async () => {
    const { payload } = await client.callTool("unity_execute_code", { code: "Lightmapping.BakeAsync();" });
    assert.equal(payload.unityConsole[0].message, "Lightmapping failed: scene has no Lighting Settings");
    assert.match(payload.warning, /Unity logged errors/);
  });

  test("warnings are attached without the error warning", async () => {
    const { payload } = await client.callTool("unity_scene_info");
    assert.equal(payload.unityConsole[0].type, "Warning");
    assert.equal(payload.warning, undefined);
  });
});

describe("concurrent calls with explicit ports (request isolation)", () => {
  /** @type {MockBridge} */ let bridgeA;
  /** @type {MockBridge} */ let bridgeB;
  /** @type {McpTestClient} */ let client;

  before(async () => {
    // Slow completion keeps calls in flight simultaneously so their polls interleave.
    bridgeA = new MockBridge({ instance: { projectName: "A", projectPath: "C:/A" }, processingDelayMs: 150 });
    bridgeB = new MockBridge({ instance: { projectName: "B", projectPath: "C:/B" }, processingDelayMs: 150 });
    // Both editors number tickets from 1 (like real plugins), so a poll sent to the wrong editor
    // finds a same-numbered ticket there and returns ITS result: tag results by origin.
    bridgeA.on("scene/info", () => ({ from: "A" }));
    bridgeB.on("editor/state", () => ({ from: "B" }));
    await bridgeA.start();
    await bridgeB.start();
    client = new McpTestClient({ env: { ...bridgeA.env(), UNITY_INSTANCE_REGISTRY: writeRegistry([bridgeA, bridgeB]) } }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await bridgeA.stop();
    await bridgeB.stop();
  });

  test("parallel calls never cross-route to the other editor", async () => {
    const calls = [];
    for (let i = 0; i < 4; i++) {
      calls.push(client.callTool("unity_scene_info", { port: bridgeA.port }));
      calls.push(client.callTool("unity_editor_state", { port: bridgeB.port }));
    }
    const results = await Promise.all(calls);
    results.forEach((r, i) => {
      assert.equal(r.isError, false, r.payloadText);
      assert.equal(r.payload.data.from, i % 2 === 0 ? "A" : "B", `call ${i} got its result from the right editor`);
    });

    const routesA = bridgeA.seen.map((r) => r.route);
    const routesB = bridgeB.seen.map((r) => r.route);
    assert.deepEqual([...new Set(routesA)], ["scene/info"], "A only received its own calls");
    assert.deepEqual([...new Set(routesB)], ["editor/state"], "B only received its own calls");
    assert.equal(routesA.length, 4);
    assert.equal(routesB.length, 4);
  });
});

describe("one server, several editors: workspace affinity", () => {
  const root = mkdtempSync(join(tmpdir(), "umcp-ws-"));
  const projectA = join(root, "GameA");
  const projectB = join(root, "GameB");
  mkdirSync(join(projectA, "Assets", "Scripts"), { recursive: true });
  mkdirSync(join(projectB, "Assets"), { recursive: true });

  /** @type {MockBridge} */ let bridgeA;
  /** @type {MockBridge} */ let bridgeB;
  let registryPath;

  before(async () => {
    bridgeA = new MockBridge({ instance: { projectName: "GameA", projectPath: unityPath(projectA) } });
    bridgeB = new MockBridge({ instance: { projectName: "GameB", projectPath: unityPath(projectB) } });
    await bridgeA.start();
    await bridgeB.start();
    registryPath = writeRegistry([bridgeA, bridgeB]);
  });

  after(async () => {
    await bridgeA.stop();
    await bridgeB.stop();
  });

  async function firstCall(options) {
    const client = new McpTestClient(options).start();
    try {
      await client.initialize();
      return await client.callTool("unity_editor_state");
    } finally {
      await client.close();
    }
  }

  test("UNITY_PROJECT_PATH picks that project's editor without a manual selection", async () => {
    bridgeB.seen = [];
    const result = await firstCall({
      env: { ...bridgeA.env(), UNITY_INSTANCE_REGISTRY: registryPath, UNITY_PROJECT_PATH: projectB },
    });
    assert.equal(result.isError, false, result.payloadText);
    const banner = result.blocks[0].text;
    assert.match(banner, /auto-connected/);
    assert.match(banner, /GameB/);
    assert.match(banner, /matches this session's workspace/);
    assert.ok(bridgeB.seen.some((r) => r.route === "editor/state"));
  });

  test("the server's working directory inside a project selects that project", async () => {
    bridgeA.seen = [];
    const result = await firstCall({
      env: { ...bridgeA.env(), UNITY_INSTANCE_REGISTRY: registryPath },
      cwd: join(projectA, "Assets", "Scripts"),
    });
    assert.equal(result.isError, false, result.payloadText);
    assert.match(result.blocks[0].text, /GameA/);
    assert.ok(bridgeA.seen.some((r) => r.route === "editor/state"));
  });

  test("a workspace containing BOTH projects is ambiguous and still asks", async () => {
    const result = await firstCall({
      env: { ...bridgeA.env(), UNITY_INSTANCE_REGISTRY: registryPath },
      cwd: root,
    });
    assert.equal(result.isError, true);
    assert.match(result.payloadText, /MULTIPLE UNITY INSTANCES/);
  });
});

describe("Multiplayer Play Mode virtual players", () => {
  /** @type {MockBridge} */ let main;
  /** @type {MockBridge} */ let player2;
  /** @type {McpTestClient} */ let client;

  before(async () => {
    main = new MockBridge({ instance: { projectName: "NetGame", projectPath: "C:/Net/Game" } });
    player2 = new MockBridge({
      instance: {
        projectName: "NetGame",
        projectPath: "C:/Net/Game/Library/VP/mppm4f2a",
        isVirtualPlayer: true,
        mainProjectPath: "C:/Net/Game",
      },
    });
    await main.start();
    await player2.start();
    client = new McpTestClient({ env: { ...main.env(), UNITY_INSTANCE_REGISTRY: writeRegistry([main, player2]) } }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await main.stop();
    await player2.stop();
  });

  test("virtual players don't block auto-selection of the main editor", async () => {
    const result = await client.callTool("unity_editor_state");
    assert.equal(result.isError, false, result.payloadText);
    assert.match(result.blocks[0].text, /virtual players ignored/);
    assert.ok(main.seen.some((r) => r.route === "editor/state"));
    assert.ok(!player2.seen.some((r) => r.route === "editor/state"));
  });

  test("instance listing flags the virtual player and carries live state", async () => {
    const { payload } = await client.callTool("unity_list_instances");
    const vp = payload.instances.find((i) => i.port === player2.port);
    const mainEntry = payload.instances.find((i) => i.port === main.port);
    assert.equal(vp.isVirtualPlayer, true);
    assert.equal(mainEntry.isVirtualPlayer, false);
    assert.equal(mainEntry.state.busy, false);
  });

  test("selecting by project name prefers the editor over its virtual players", async () => {
    const { payload } = await client.callTool("unity_select_instance", { projectName: "NetGame" });
    assert.equal(payload.success, true, JSON.stringify(payload));
    assert.equal(payload.instance.port, main.port);
  });
});

describe("lightmap bake (issue: endless polling for a bake that never started)", () => {
  /** @type {MockBridge} */ let bridge;
  /** @type {McpTestClient} */ let client;
  let statusSequence = [];

  before(async () => {
    bridge = new MockBridge();
    bridge.on("lighting/bake", () => ({
      success: true, started: true, bakeId: 1, scene: "Assets/Main.unity",
      settings: { bakedGI: true, contributeGIRenderers: 12 }, hints: [],
    }));
    bridge.on("lighting/bake-status", () => statusSequence.shift() || { state: "Idle", isRunning: false });
    await bridge.start();
    client = new McpTestClient({ env: bridge.env(), timeoutMs: 30_000 }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await bridge.stop();
  });

  test("waits server-side and returns the final Completed state", async () => {
    statusSequence = [
      { state: "Running", isRunning: true, progress: 0.4, elapsedSeconds: 2 },
      { state: "Completed", isRunning: false, progress: 1, elapsedSeconds: 4, lightmapCount: 3 },
    ];
    const { payload, isError } = await client.callTool("unity_advanced_tool", {
      tool: "unity_lighting_bake",
      params: { waitSeconds: 20 },
    });
    assert.equal(isError, false, JSON.stringify(payload));
    assert.equal(payload.started, true);
    assert.equal(payload.bake.state, "Completed");
    assert.equal(payload.bake.lightmapCount, 3);
  });

  test("a bake that stops without completing is an error, not a success", async () => {
    statusSequence = [{ state: "Failed", isRunning: false, hint: "The bake stopped without completing." }];
    const { payload, isError } = await client.callTool("unity_advanced_tool", {
      tool: "unity_lighting_bake",
      params: { waitSeconds: 20 },
    });
    assert.equal(isError, true);
    assert.match(payload.error, /Lightmap bake failed/);
  });

  test("a refused bake surfaces the plugin's reason immediately", async () => {
    bridge.on("lighting/bake", () => ({ success: false, started: false, error: "Cannot bake lighting in Play mode." }));
    const started = Date.now();
    const { payloadText, isError } = await client.callTool("unity_advanced_tool", { tool: "unity_lighting_bake" });
    assert.equal(isError, true);
    assert.match(payloadText, /Play mode/);
    assert.ok(Date.now() - started < 2000, "no waiting on a bake that never started");
  });
});

describe("asset refresh (issue: 'Unity only refreshes when its window is focused')", () => {
  /** @type {MockBridge} */ let bridge;
  /** @type {McpTestClient} */ let client;
  let compileErrors = [];

  before(async () => {
    bridge = new MockBridge();
    // Background editor: an explicit refresh must not depend on focus.
    bridge.editor.applicationFocused = false;
    bridge.on("compilation/errors", () => ({ count: compileErrors.length, isCompiling: false, entries: compileErrors }));
    await bridge.start();
    client = new McpTestClient({ env: bridge.env(), timeoutMs: 30_000 }).start();
    await client.initialize();
  });

  after(async () => {
    await client.close();
    await bridge.stop();
  });

  /** Plugin-side refresh that starts a compile ending after `ms`, optionally with a domain reload. */
  function compileFor(ms, { reload }) {
    bridge.on("asset/refresh", () => {
      bridge.editor.isCompiling = true;
      setTimeout(() => {
        bridge.editor.isCompiling = false;
        if (reload) bridge.instance.epoch = `${bridge.instance.epoch}+`;
      }, ms);
      return { success: true, compiling: true, refreshMs: 12, epoch: bridge.instance.epoch };
    });
  }

  test("nothing to compile: answers without waiting", async () => {
    bridge.on("asset/refresh", () => ({ success: true, compiling: false, refreshMs: 5, epoch: bridge.instance.epoch }));
    const started = Date.now();
    const { payload, isError } = await client.callTool("unity_asset_refresh");
    assert.equal(isError, false, JSON.stringify(payload));
    assert.equal(payload.compilation, "none");
    assert.ok(Date.now() - started < 1500, "no compile wait when nothing compiles");
  });

  test("waits out the compile and reports the domain reload", async () => {
    compileFor(800, { reload: true });
    const { payload, isError } = await client.callTool("unity_asset_refresh");
    assert.equal(isError, false, JSON.stringify(payload));
    assert.equal(payload.compilation, "succeeded");
    assert.equal(payload.domainReloaded, true);
    assert.ok(payload.waitedMs >= 700, `waited for the compile (${payload.waitedMs}ms)`);
  });

  test("a failed compile (no reload) returns the compile errors", async () => {
    compileErrors = [{ file: "Assets/Foo.cs", line: 3, column: 5, message: "CS1002: ; expected", severity: "error" }];
    compileFor(500, { reload: false });
    const { payload } = await client.callTool("unity_asset_refresh");
    assert.equal(payload.compilation, "failed");
    assert.equal(payload.errors.length, 1);
    assert.match(payload.warning, /failed to compile/);
  });

  test("waitSeconds 0 returns while still compiling", async () => {
    compileFor(5000, { reload: true });
    const { payload } = await client.callTool("unity_asset_refresh", { waitSeconds: 0 });
    assert.equal(payload.compilation, "pending");
    assert.ok(payload.next);
  });
});
