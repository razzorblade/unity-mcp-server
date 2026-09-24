import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  MATCH,
  normalizePath,
  scoreMatch,
  pickInstanceForWorkspace,
  isVirtualPlayerInstance,
  rootsToPaths,
} from "../../src/workspace-affinity.js";

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

describe("workspace affinity", () => {
  test("normalizePath unifies separators and trailing slashes", () => {
    assert.equal(normalizePath("C:\\Proj\\Game\\"), CASE_INSENSITIVE ? "c:/proj/game" : "C:/Proj/Game");
    assert.equal(normalizePath(""), "");
    assert.equal(normalizePath(undefined), "");
  });

  test("scoreMatch ranks exact > inside project > nested project", () => {
    assert.equal(scoreMatch("/w/Game", "/w/Game"), MATCH.EXACT);
    assert.equal(scoreMatch("/w/Game", "/w/Game/Assets/Scripts"), MATCH.INSIDE_PROJECT);
    assert.equal(scoreMatch("/w/repo/unity/Game", "/w/repo"), MATCH.NESTED_PROJECT);
    assert.equal(scoreMatch("/w/Game", "/w/GameTwo"), MATCH.NONE, "prefix of a sibling is not a match");
    assert.equal(scoreMatch("/w/a/b/c/d/Game", "/w"), MATCH.NONE, "too deep below the root");
  });

  test("home directory and filesystem roots are too broad to claim nested projects", () => {
    assert.equal(scoreMatch(`${homedir()}/Projects/Game`, homedir()), MATCH.NONE);
    assert.equal(scoreMatch("/Game", "/"), MATCH.NONE);
    assert.equal(scoreMatch("C:/Game", "C:/"), MATCH.NONE);
  });

  test("pickInstanceForWorkspace returns the unique best match, null when tied", () => {
    const a = { port: 1, projectPath: "/w/repo/GameA" };
    const b = { port: 2, projectPath: "/w/repo/GameB" };
    assert.equal(pickInstanceForWorkspace([a, b], ["/w/repo/GameB/Assets"]).instance, b);
    assert.equal(pickInstanceForWorkspace([a, b], ["/w/repo"]), null, "both nested equally → ambiguous");
    assert.equal(pickInstanceForWorkspace([a, b], ["/elsewhere"]), null);
    assert.equal(pickInstanceForWorkspace([a, b], []), null);
  });

  test("a closer match beats an earlier weaker one", () => {
    const a = { port: 1, projectPath: "/w/repo/GameA" };
    const b = { port: 2, projectPath: "/w/repo/GameB" };
    const pick = pickInstanceForWorkspace([a, b], ["/w/repo", "/w/repo/GameB"]);
    assert.equal(pick.instance, b);
    assert.equal(pick.score, MATCH.EXACT);
  });

  test("MPPM virtual players are recognized and never picked", () => {
    const main = { port: 1, projectPath: "/w/Net" };
    const vpFlagged = { port: 2, projectPath: "/w/Other", isVirtualPlayer: true };
    const vpByPath = { port: 3, projectPath: "/w/Net/Library/VP/mppm1" };
    assert.equal(isVirtualPlayerInstance(vpFlagged), true);
    assert.equal(isVirtualPlayerInstance(vpByPath), true);
    assert.equal(isVirtualPlayerInstance(main), false);
    assert.equal(pickInstanceForWorkspace([main, vpByPath], ["/w/Net/Library/VP/mppm1"]).instance, main);
  });

  test("rootsToPaths accepts file URIs and plain paths, drops other schemes", () => {
    const fileUri = pathToFileURL(process.cwd()).href;
    const paths = rootsToPaths([{ uri: fileUri }, "/plain/path", { uri: "https://example.com" }, {}]);
    assert.equal(paths.length, 2);
    assert.equal(normalizePath(paths[0]), normalizePath(process.cwd()));
    assert.equal(paths[1], "/plain/path");
  });
});
