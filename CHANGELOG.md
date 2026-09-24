# Changelog

All notable changes to this package will be documented in this file.

## [2.37.0] - 2026-09-25

Companion to plugin **2.41.0** (token-dense responses). Works with older plugins, which simply keep their verbose shapes.

### Added
- **Token-budget paging.** MCP clients cap how much of a tool result reaches the model (Claude Code: 25k tokens by default) and silently cut the rest. A result over `UNITY_MCP_MAX_RESPONSE_TOKENS` (default 20000, estimated; `0` = off) now arrives as page 1 plus a notice, and the rest comes through the new **`unity_page {cursor, page}`** tool.
  - Pages are cut along the data's structure, so every page is valid JSON with the same outer shape. Small context (the envelope, `columns`, `common`, a node's name and id) repeats on every page, while lists and groups continue across pages.
  - Pages come from one cached snapshot (the 16 most recent results, 15 min), so fetching the next page never re-runs the command in Unity.
- **`unity_console_log` collapses identical entries** after trimming stack traces, with `repeats`, `firstTimestamp` and the latest `timestamp`. This also works with older plugins, and merges traces that differed only in trimmed frames. Pass `collapse:false` for every entry.
- New parameters for the plugin's dense reads:
  - `propertyPath`, `maxDepth` and `maxArrayElements` on the component, prefab and ScriptableObject property reads;
  - `offset` and `includeGuid` on `unity_asset_list`;
  - `includeGuid` on `unity_search_assets`;
  - `limit` on `unity_selection_find_by_type` and `unity_packages_search`;
  - `maxNodes` on `unity_prefab_get_hierarchy`;
  - `previewSize` on `unity_graphics_material_info` and `includePreview` on `unity_graphics_texture_info`.
- `verbose:true` restores the legacy response shape. It appears in the advanced-tier schemas only, because `tools/list` is paid every session; every dense plugin endpoint accepts it anyway.

### Fixed
- **`unity_graphics_mesh_info`, `material_info` and `renderer_info` dropped the object path** against plugins that read `gameObjectPath`. `objectPath` is now also sent as `gameObjectPath`.

### Changed
- `tools/list` is 47.9 KB (compact mode: 23.4 KB). The rich-mode gate moves from 48 KB to 49.5 KB for `unity_page`, nested-property reads, asset paging and console collapse.
- Tests: 83 → 101 (`tests/paging.test.mjs`, `tests/unit/pagination.test.mjs`).
  - The oversized-response test now asserts paging.
  - The 4 MB transport guard is covered with paging disabled.
  - The live ProBuilder test accepts array positions.

