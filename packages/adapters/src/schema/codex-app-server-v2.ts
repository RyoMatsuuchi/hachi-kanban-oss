// Codex CLI 0.144.1 の `app-server generate-json-schema --experimental` から、
// この adapter が利用する v2 面だけを抜き出した pin。全 schema bundle は生成時の
// checksum を保持し、ここでは wire contract の drift を検出するための最小 fixture を公開する。

export const CODEX_APP_SERVER_CLI_VERSION = "0.144.1" as const;
export const CODEX_APP_SERVER_SCHEMA_VERSION = "v2" as const;

export const CODEX_APP_SERVER_SCHEMA_SOURCE =
  "codex-cli 0.144.1 app-server generate-json-schema --experimental" as const;

export const CODEX_APP_SERVER_METHODS = [
  "initialize",
  "initialized",
  "thread/start",
  "turn/start",
  "thread/read",
  "turn/steer",
  "turn/interrupt",
] as const;

export type CodexAppServerMethod = (typeof CODEX_APP_SERVER_METHODS)[number];

/**
 * 生成 schema の required fields と、adapter が送信する discriminant だけを固定する。
 * optional な provider-specific field をここへ写経しないことで、fixture 自体を小さく保つ。
 */
export const CODEX_APP_SERVER_SCHEMA_FIXTURE = {
  protocol: "json-rpc-2.0",
  version: CODEX_APP_SERVER_SCHEMA_VERSION,
  methods: {
    initialize: {
      paramsRequired: ["clientInfo"],
      resultRequired: ["codexHome", "platformFamily", "platformOs", "userAgent"],
    },
    initialized: {
      notification: true,
    },
    "thread/start": {
      paramsRequired: [],
      resultRequired: ["thread"],
      threadRequired: [
        "cliVersion",
        "createdAt",
        "cwd",
        "ephemeral",
        "id",
        "modelProvider",
        "preview",
        "sessionId",
        "source",
        "status",
        "turns",
        "updatedAt",
      ],
    },
    "turn/start": {
      paramsRequired: ["input", "threadId"],
      resultRequired: ["turn"],
      turnRequired: ["id", "items", "status"],
    },
    "thread/read": {
      paramsRequired: ["threadId"],
      resultRequired: ["thread"],
    },
    "turn/steer": {
      paramsRequired: ["expectedTurnId", "input", "threadId"],
      resultRequired: ["turnId"],
    },
    "turn/interrupt": {
      paramsRequired: ["threadId", "turnId"],
      resultRequired: [],
    },
  },
} as const;

/**
 * SHA-256 of the raw bytes of `codex_app_server_protocol.v2.schemas.json` emitted by
 * `codex app-server generate-json-schema --experimental` from CLI 0.144.1.
 *
 * Keep this separate from the minimum fixture below: `JSON.stringify(parsed)` and a
 * recursively key-sorted JSON representation are different byte streams and are not
 * the generated bundle checksum. Reproduce the pin by running the command with the
 * pinned CLI and hashing that exact v2 bundle file (`shasum -a 256 <file>`).
 */
export const CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256 =
  "092f12a1107c1a156ca85cafca77fb553d9c9846e53a2a744e2f2aef88544f51" as const;

/** SHA-256 of JSON.stringify(CODEX_APP_SERVER_SCHEMA_FIXTURE), for fixture-level tests. */
export const CODEX_APP_SERVER_SCHEMA_FIXTURE_SHA256 =
  "3add4bc60448773f72b571f833da534a4913b6e7c164b434b9243a4836b482e1" as const;

/** Native capability evidence uses the raw lowercase hash required by Core/DB. */
export const CODEX_APP_SERVER_SCHEMA_CHECKSUM =
  CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256;

export const CODEX_APP_SERVER_SCHEMA_SHA256 = CODEX_APP_SERVER_SCHEMA_CHECKSUM;

export interface CodexAppServerSchemaPin {
  readonly runtimeVersion: typeof CODEX_APP_SERVER_CLI_VERSION;
  readonly schemaVersion: typeof CODEX_APP_SERVER_SCHEMA_VERSION;
  readonly checksum: typeof CODEX_APP_SERVER_SCHEMA_CHECKSUM;
}

export const CODEX_APP_SERVER_SCHEMA_PIN: CodexAppServerSchemaPin = {
  runtimeVersion: CODEX_APP_SERVER_CLI_VERSION,
  schemaVersion: CODEX_APP_SERVER_SCHEMA_VERSION,
  checksum: CODEX_APP_SERVER_SCHEMA_CHECKSUM,
};
