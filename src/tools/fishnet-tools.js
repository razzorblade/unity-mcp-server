// AnkleBreaker Unity MCP - Fish-Networking (FishNet) tool definitions
// Functional only when FishNet 4.x (com.firstgeargames.fishnet) is installed as a package.
// The C# side is gated on FISHNET_INSTALLED; without FishNet every call returns a clear
// "not installed" error. All tools live in the advanced tier (unity_fishnet_*), reachable via
// unity_advanced_tool and listed under the "fishnet" category.
//
// Edit Mode tools set a project up (NetworkManager, NetworkObjects, spawnable prefabs);
// Play Mode tools drive a live session (start/stop, spawn, ownership, scenes). Each tool
// name derives to its plugin route (unity_fishnet_list_prefabs -> fishnet/list-prefabs).
import { sendCommand } from "../unity-editor-bridge.js";
import { formatResult } from "../response-format.js";

/** Handler that forwards the tool's params to one plugin route. */
const forward = (route) => async (params) => formatResult(await sendCommand(route, params || {}));

const NETWORK_MANAGER_PROP = {
  networkManager: {
    type: "string",
    description: "Hierarchy path of the NetworkManager. Only needed when the loaded scenes hold more than one.",
  },
};

// Scene-object / prefab targeting shared by the NetworkObject tools.
const SCENE_TARGET_PROPS = {
  path: { type: "string", description: "Hierarchy path of the scene GameObject (e.g. 'World/Crate')." },
  instanceId: { type: "string", description: "Unity instance id (string form) of the scene GameObject." },
};

const OBJECT_ID_PROP = {
  objectId: { type: "number", description: "FishNet ObjectId of a spawned object (Play Mode; see unity_fishnet_list_network_objects)." },
};

const VEC3_PROP = (description) => ({
  type: "object",
  description,
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
});

const NOB_SETTING_PROPS = {
  isNetworked: { type: "boolean", description: "Initialize over the network automatically (default true)." },
  isSpawnable: { type: "boolean", description: "Can be spawned at runtime (default true)." },
  isGlobal: { type: "boolean", description: "Move to DontDestroyOnLoad and stay visible across scenes. Instantiated objects only." },
  initializeOrder: { type: "number", description: "Callback order among objects spawned in the same tick (-128..127, lower first)." },
  preventDespawnOnDisconnect: { type: "boolean", description: "Keep the object spawned when its owner disconnects." },
  defaultDespawnType: { type: "string", enum: ["Destroy", "Pool"], description: "What despawning does by default." },
};

const TRANSPORT_SETTING_PROPS = {
  port: { type: "number", description: "Port the server listens on and the client connects to." },
  clientAddress: { type: "string", description: "Address the client connects to (e.g. 'localhost', '127.0.0.1')." },
  maxClients: { type: "number", description: "Maximum simultaneous clients." },
  bindAddressIPv4: { type: "string", description: "IPv4 address the server binds to (empty = any)." },
  bindAddressIPv6: { type: "string", description: "IPv6 address the server binds to (empty = any)." },
};

export const fishnetTools = [
  // ─── Inspect ───
  {
    name: "unity_fishnet_status",
    description:
      "FishNet overview: installed version, every NetworkManager with its state (offline/server/client/host), transport, " +
      "port, spawnable-prefab collection, and in Play Mode client count, spawned counts, tick and RTT. Start here.",
    inputSchema: { type: "object", properties: {} },
    handler: forward("fishnet/status"),
  },
  {
    name: "unity_fishnet_get_network_object",
    description:
      "Inspect one NetworkObject: its settings, NetworkBehaviours and their SyncType values (SyncVar, SyncList, SyncDictionary, " +
      "SyncHashSet, SyncTimer, SyncStopwatch), nested NetworkObjects, and in Play Mode ObjectId, owner, observers and init state. " +
      "Target a spawned object by objectId, a scene object by path/instanceId, or a prefab asset by prefabPath.",
    inputSchema: {
      type: "object",
      properties: {
        ...OBJECT_ID_PROP,
        ...SCENE_TARGET_PROPS,
        prefabPath: { type: "string", description: "Prefab asset path (e.g. 'Assets/Prefabs/Player.prefab')." },
        maxItems: { type: "number", description: "Items shown per SyncList/SyncDictionary (default 20)." },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/get-network-object"),
  },
  {
    name: "unity_fishnet_list_network_objects",
    description:
      "List NetworkObjects. While a session runs: the spawned objects (objectId, owner, prefabId, observers) from the server " +
      "side, or the client side with side:'client'. Otherwise: the NetworkObjects placed in the loaded scenes.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["server", "client"], description: "Which spawned set to list in Play Mode (default: server if started)." },
        nameFilter: { type: "string", description: "Case-insensitive substring match on the object name." },
        limit: { type: "number", description: "Max rows (default 200)." },
        verbose: { type: "boolean", description: "Rows as objects instead of a table" },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/list-network-objects"),
  },
  {
    name: "unity_fishnet_list_prefabs",
    description:
      "List the spawnable prefab collection (the NetworkManager's SpawnablePrefabs, else DefaultPrefabObjects). " +
      "In Play Mode each row carries the runtime prefabId that unity_fishnet_spawn accepts.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Asset path of a specific PrefabObjects collection." },
        offset: { type: "number", description: "Paging offset (default 0)." },
        limit: { type: "number", description: "Max rows (default 200)." },
        verbose: { type: "boolean", description: "Rows as objects instead of a table" },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/list-prefabs"),
  },

  // ─── Edit Mode setup ───
  {
    name: "unity_fishnet_setup_network_manager",
    description:
      "Edit Mode: create a NetworkManager in the open scene (or complete one on an existing GameObject via path) with a " +
      "TransportManager and transport (Tugboat by default), spawnable prefabs assigned, and optionally a PlayerSpawner. " +
      "Refuses to add a second manager unless allowMultiple. Undo-tracked.\n\n" +
      'EXAMPLE: { "port": 7770, "playerPrefab": "Assets/Prefabs/Player.prefab", "spawnPoints": ["Spawns/A", "Spawns/B"] }',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for a new NetworkManager GameObject (default 'NetworkManager')." },
        path: { type: "string", description: "Add the manager to this existing GameObject instead of creating one." },
        transport: { type: "string", description: "Transport type name (default 'Tugboat'; e.g. 'Multipass', 'Bayou'). Replaces the current transport when given." },
        ...TRANSPORT_SETTING_PROPS,
        spawnablePrefabs: { type: "string", description: "PrefabObjects asset path (default: DefaultPrefabObjects)." },
        playerPrefab: { type: "string", description: "Prefab asset path with a NetworkObject. Adds a PlayerSpawner that spawns it for each client." },
        spawnPoints: { type: "array", items: { type: "string" }, description: "Hierarchy paths of Transforms the PlayerSpawner cycles through." },
        addAllManagers: { type: "boolean", description: "Also add Server/Client/Time/Scene/ObserverManager so their settings show in the Inspector (FishNet otherwise adds them on Awake)." },
        allowMultiple: { type: "boolean", description: "Create another NetworkManager even if one exists." },
      },
    },
    handler: forward("fishnet/setup-network-manager"),
  },
  {
    name: "unity_fishnet_configure_transport",
    description:
      "Read or change the NetworkManager's transport settings (port, client address, max clients, bind addresses). " +
      "Edit Mode: saved in the scene, Undo-tracked, and the full serialized transport settings are returned. " +
      "Play Mode: applies to the next start only. Call with no settings to just read them.",
    inputSchema: {
      type: "object",
      properties: { ...TRANSPORT_SETTING_PROPS, ...NETWORK_MANAGER_PROP },
    },
    handler: forward("fishnet/configure-transport"),
  },
  {
    name: "unity_fishnet_add_network_object",
    description:
      "Edit Mode: add a NetworkObject (idempotent) to a scene GameObject (path/instanceId) or a prefab asset root (prefabPath), " +
      "and apply its settings. networkTransform:true also adds a NetworkTransform. For prefabs, reports whether the prefab " +
      "is already in the spawnable collection. Invalid settings fail before anything changes.",
    inputSchema: {
      type: "object",
      properties: {
        ...SCENE_TARGET_PROPS,
        prefabPath: { type: "string", description: "Prefab asset path; the NetworkObject goes on the prefab root." },
        networkTransform: { type: "boolean", description: "Also add a NetworkTransform (synchronizes the transform)." },
        ...NOB_SETTING_PROPS,
      },
    },
    handler: forward("fishnet/add-network-object"),
  },
  {
    name: "unity_fishnet_refresh_prefabs",
    description:
      "Edit Mode: rebuild DefaultPrefabObjects from the project (FishNet's 'Refresh Default Prefabs'). Run after adding, " +
      "moving or deleting networked prefabs if auto-generation missed them.",
    inputSchema: { type: "object", properties: {} },
    handler: forward("fishnet/refresh-prefabs"),
  },
  {
    name: "unity_fishnet_register_prefab",
    description:
      "Edit Mode: make a prefab spawnable by adding it to the NetworkManager's collection (or `collection`). For " +
      "DefaultPrefabObjects this regenerates the collection and verifies the prefab was picked up. " +
      "addNetworkObject:true adds a missing NetworkObject first.",
    inputSchema: {
      type: "object",
      properties: {
        prefabPath: { type: "string", description: "Prefab asset path (e.g. 'Assets/Prefabs/Bullet.prefab')." },
        collection: { type: "string", description: "Asset path of the PrefabObjects collection (default: the NetworkManager's)." },
        addNetworkObject: { type: "boolean", description: "Add a NetworkObject to the prefab root if it has none." },
        ...NETWORK_MANAGER_PROP,
      },
      required: ["prefabPath"],
    },
    handler: forward("fishnet/register-prefab"),
  },

  // ─── Play Mode session ───
  {
    name: "unity_fishnet_start",
    description:
      "Play Mode: start FishNet as host (default), server or client, and wait until the server is listening and/or the " +
      "client is connected and authenticated (waitSeconds, default 5, max 30; 0 = return immediately). Enter Play Mode " +
      "first with unity_play_mode. For multiplayer tests, host here and start clients on MPPM virtual players.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["host", "server", "client"], description: "What to start (default host)." },
        address: { type: "string", description: "Client: server address to connect to (default: the transport's client address)." },
        port: { type: "number", description: "Port to listen on / connect to (default: the transport's port)." },
        waitSeconds: { type: "number", description: "How long to wait for the connection (default 5, max 30, 0 = don't wait)." },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/start"),
  },
  {
    name: "unity_fishnet_stop",
    description: "Play Mode: stop the client, the server, or both (default all). Stopping the server disconnects every client.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "server", "client"], description: "What to stop (default all)." },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/stop"),
  },
  {
    name: "unity_fishnet_list_connections",
    description:
      "Play Mode: connected clients as seen by the server (clientId, address, authenticated, loaded start scenes, owned " +
      "object count, first object, scenes, isLocal), plus the local client's id and RTT.",
    inputSchema: {
      type: "object",
      properties: {
        verbose: { type: "boolean", description: "Rows as objects instead of a table" },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/list-connections"),
  },
  {
    name: "unity_fishnet_spawn",
    description:
      "Play Mode, server: instantiate a registered prefab (pooled) and spawn it over the network, optionally owned by a " +
      "client. Identify the prefab by name, asset path, or runtime prefabId. Returns each spawned objectId.\n\n" +
      'EXAMPLE: { "prefab": "Enemy", "count": 3, "position": {"x":0,"y":1,"z":5}, "ownerClientId": 0 }',
    inputSchema: {
      type: "object",
      properties: {
        prefab: { type: "string", description: "Prefab name in the spawnable collection, or its asset path." },
        prefabId: { type: "number", description: "Runtime prefabId (see unity_fishnet_list_prefabs in Play Mode)." },
        position: VEC3_PROP("World position (default: the prefab's)."),
        rotation: VEC3_PROP("Euler rotation in degrees (default: the prefab's)."),
        ownerClientId: { type: "number", description: "Client that owns the spawned object (omit or -1 for server-owned)." },
        count: { type: "number", description: "How many to spawn (default 1, max 100)." },
        name: { type: "string", description: "GameObject name (suffixed _0, _1, ... when count > 1)." },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/spawn"),
  },
  {
    name: "unity_fishnet_despawn",
    description: "Play Mode, server: despawn a spawned object by objectId (or path/instanceId), destroying or pooling it.",
    inputSchema: {
      type: "object",
      properties: {
        ...OBJECT_ID_PROP,
        ...SCENE_TARGET_PROPS,
        despawnType: { type: "string", enum: ["Destroy", "Pool"], description: "Override the object's default despawn type." },
        ...NETWORK_MANAGER_PROP,
      },
    },
    handler: forward("fishnet/despawn"),
  },
  {
    name: "unity_fishnet_set_ownership",
    description: "Play Mode, server: give a spawned object to a client (clientId), or remove its owner (clientId -1).",
    inputSchema: {
      type: "object",
      properties: {
        ...OBJECT_ID_PROP,
        ...SCENE_TARGET_PROPS,
        clientId: { type: "number", description: "New owner's clientId, or -1 to remove ownership." },
        includeNested: { type: "boolean", description: "Apply to nested NetworkObjects too (default false)." },
        ...NETWORK_MANAGER_PROP,
      },
      required: ["clientId"],
    },
    handler: forward("fishnet/set-ownership"),
  },
  {
    name: "unity_fishnet_kick",
    description: "Play Mode, server: disconnect a client.",
    inputSchema: {
      type: "object",
      properties: {
        clientId: { type: "number", description: "Client to kick (see unity_fishnet_list_connections)." },
        reason: {
          type: "string",
          enum: ["Unset", "ExploitAttempt", "MalformedData", "ExploitExcessiveData", "ExcessiveData", "UnexpectedProblem", "UnusualActivity"],
          description: "Kick reason passed to FishNet (default Unset).",
        },
        message: { type: "string", description: "Optional message for the server log." },
        ...NETWORK_MANAGER_PROP,
      },
      required: ["clientId"],
    },
    handler: forward("fishnet/kick"),
  },
  {
    name: "unity_fishnet_load_scene",
    description:
      "Play Mode, server: load scenes through FishNet's SceneManager so clients follow. Global by default, or only for " +
      "clientIds. Scenes must be enabled in Build Settings. The load is queued and completes over the next frames.",
    inputSchema: {
      type: "object",
      properties: {
        scenes: { type: "array", items: { type: "string" }, description: "Scene names (or Build Settings paths)." },
        replace: { type: "string", enum: ["none", "online", "all"], description: "Unload existing scenes: none (additive, default), online (FishNet-loaded only) or all." },
        clientIds: { type: "array", items: { type: "number" }, description: "Load only for these clients (connection scenes). Omit for global." },
        ...NETWORK_MANAGER_PROP,
      },
      required: ["scenes"],
    },
    handler: forward("fishnet/load-scene"),
  },
  {
    name: "unity_fishnet_unload_scene",
    description: "Play Mode, server: unload scenes through FishNet's SceneManager, globally or only for clientIds.",
    inputSchema: {
      type: "object",
      properties: {
        scenes: { type: "array", items: { type: "string" }, description: "Scene names (or Build Settings paths)." },
        clientIds: { type: "array", items: { type: "number" }, description: "Unload only for these clients. Omit for global." },
        ...NETWORK_MANAGER_PROP,
      },
      required: ["scenes"],
    },
    handler: forward("fishnet/unload-scene"),
  },
];
