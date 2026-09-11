import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_RUNTIME_GENERATION_SCHEMA,
  EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
  EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
  externalRuntimeGenerationEndpointIdentityHash,
  type ExternalRuntimeGenerationAttestationV1,
  type ExternalRuntimeGenerationIdentityV1,
  type ExternalRuntimeGenerationStatusV1,
} from "@hachi/core";
import {
  NodeExternalRuntimeGenerationReader,
  type ExternalRuntimeGenerationOpenedPathReader,
  type ExternalRuntimeGenerationProcessIdentityReader,
} from "./external-runtime-generation-reader.js";
import { resolveExternalRuntimeGenerationRoot } from "./external-runtime-generation-root.js";

const NOW = 2_000_000_000_000;
const PROCESS_START = "darwin-ps-lstart:Mon Aug 25 10:11:12 2026";
const ORIGIN = "http://127.0.0.1:3456";
const CLAUDE_ORIGIN = "http://127.0.0.1:3457";

class FakeProcessIdentityReader implements ExternalRuntimeGenerationProcessIdentityReader {
  readonly values = new Map<number, string | null>([[101, PROCESS_START], [202, PROCESS_START]]);

  async read(pid: number): Promise<string | null> {
    return this.values.get(pid) ?? null;
  }
}

function identity(endpointIdentityHash = externalRuntimeGenerationEndpointIdentityHash("codex", ORIGIN)):
ExternalRuntimeGenerationIdentityV1 {
  return {
    kind: "external-shared-runtime",
    generationId: "1".repeat(32),
    runtimeModelId: "gpt-5.6-sol",
    modelReadbackSource: "codex-applied-model",
    writerPid: 101,
    writerProcessStart: PROCESS_START,
    runtimePid: 202,
    runtimeProcessStart: PROCESS_START,
    bootNonce: "2".repeat(32),
    endpointIdentityHash,
    startedAt: NOW - 10_000,
  };
}

function runningStatus(endpointIdentityHash?: string): {
  status: ExternalRuntimeGenerationStatusV1;
  attestation: ExternalRuntimeGenerationAttestationV1;
} {
  const observedAt = NOW - 1_000;
  const value = identity(endpointIdentityHash);
  const attestation: ExternalRuntimeGenerationAttestationV1 = {
    version: 1,
    schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
    provider: "codex",
    lane: "even-shared",
    runtimeKey: "external-shared-runtime/codex/even-shared",
    statusRevision: 1,
    state: "running",
    identity: value,
    observedAt,
    ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  return {
    attestation,
    status: {
      schema: EXTERNAL_RUNTIME_GENERATION_SCHEMA,
      schemaVersion: 1,
      schemaHash: EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH,
      provider: "codex",
      lane: "even-shared",
      runtimeKey: "external-shared-runtime/codex/even-shared",
      revision: 1,
      state: "running",
      attestations: [attestation],
      transitions: [{
        version: 1,
        revision: 1,
        kind: "running",
        oldIdentity: null,
        newIdentity: value,
        lastSeenAt: null,
        stoppedAt: null,
        replacementFirstSeenAt: null,
        observedAt,
        ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        source: "endpoint-observer",
      }],
      observedAt,
      ttlMs: EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
      expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    },
  };
}

function stoppedStatus(
  observedAt = NOW - EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS - 1,
): ExternalRuntimeGenerationStatusV1 {
  const oldIdentity = { ...identity(), startedAt: observedAt - 10_000 };
  const runningObservedAt = observedAt - 1_000;
  const runningTransition = runningStatus().status.transitions[0]!;
  return {
    ...runningStatus().status,
    revision: 2,
    state: "stopped",
    attestations: [],
    transitions: [
      {
        ...runningTransition,
        newIdentity: oldIdentity,
        observedAt: runningObservedAt,
        expiresAt: runningObservedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
      },
      {
        version: 1,
        revision: 2,
        kind: "stopped",
        oldIdentity,
        newIdentity: null,
        lastSeenAt: observedAt - 200,
        stoppedAt: observedAt - 100,
        replacementFirstSeenAt: null,
        observedAt,
        ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        source: "owner-wait",
      },
    ],
    observedAt,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
}

function staleNonTerminalStatus(state: "running" | "unknown"): ExternalRuntimeGenerationStatusV1 {
  const observedAt = NOW - EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS - 1;
  const value = { ...identity(), startedAt: observedAt - 10_000 };
  const attestation: ExternalRuntimeGenerationAttestationV1 = {
    ...runningStatus().attestation,
    identity: value,
    observedAt: observedAt - 1_000,
    expiresAt: observedAt - 1_000 + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
  const runningTransition = {
    ...runningStatus().status.transitions[0]!,
    newIdentity: value,
    observedAt: observedAt - 1_000,
    expiresAt: observedAt - 1_000 + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
  };
  if (state === "running") {
    return {
      ...runningStatus().status,
      attestations: [attestation],
      transitions: [runningTransition],
      observedAt,
      expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
    };
  }
  return {
    ...runningStatus().status,
    revision: 2,
    state: "unknown",
    attestations: [],
    transitions: [
      runningTransition,
      {
        version: 1,
        revision: 2,
        kind: "unknown",
        oldIdentity: value,
        newIdentity: null,
        lastSeenAt: observedAt - 100,
        stoppedAt: null,
        replacementFirstSeenAt: null,
        observedAt,
        ttlMs: EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS,
        source: "endpoint-observer",
      },
    ],
    observedAt,
    expiresAt: observedAt + EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS,
  };
}

function claudeRunningStatus(): {
  status: ExternalRuntimeGenerationStatusV1;
  attestation: ExternalRuntimeGenerationAttestationV1;
} {
  const running = runningStatus();
  const toClaudeIdentity = (value: ExternalRuntimeGenerationIdentityV1 | null):
  ExternalRuntimeGenerationIdentityV1 | null => value === null ? null : {
    ...value,
    modelReadbackSource: "claude-runtime-model",
    endpointIdentityHash: externalRuntimeGenerationEndpointIdentityHash("claude", CLAUDE_ORIGIN),
  };
  const attestation: ExternalRuntimeGenerationAttestationV1 = {
    ...running.attestation,
    provider: "claude",
    lane: "even-claude",
    runtimeKey: "external-shared-runtime/claude/even-claude",
    identity: toClaudeIdentity(running.attestation.identity)!,
  };
  return {
    attestation,
    status: {
      ...running.status,
      provider: "claude",
      lane: "even-claude",
      runtimeKey: "external-shared-runtime/claude/even-claude",
      attestations: [attestation],
      transitions: running.status.transitions.map((entry) => ({
        ...entry,
        oldIdentity: toClaudeIdentity(entry.oldIdentity),
        newIdentity: toClaudeIdentity(entry.newIdentity),
      })),
    },
  };
}

describe("external runtime generation bounded reader", () => {
  const roots: string[] = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;

  afterEach(() => {
    for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
  });

  // shared /tmp はancestorがgroup/other-writableなhostがあり root_invalid化するため、
  // canonical workspace（package cwd）配下のtest-owned private directoryへfixtureを作る。
  function fixtureRoot(laneName = "even-shared"): { root: string; lane: string; statusPath: string } {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".external-reader-")));
    roots.push(root);
    chmodSync(root, 0o700);
    const lane = join(root, laneName);
    mkdirSync(lane, { mode: 0o700 });
    const statusPath = join(lane, "external-runtime-generation-status.json");
    const resolution = resolveExternalRuntimeGenerationRoot({ env: { HERMES_HOME: root }, accountHome: "/unused", uid });
    if (!resolution.ok) {
      throw new Error(
        `テスト前提エラー: fixtureRoot ${root} をresolverが受理しませんでした（code=${resolution.code}）。` +
        "実行環境のancestor owner/modeを確認してください。",
      );
    }
    return { root, lane, statusPath };
  }

  // semantic testsはOS外部プロセス（lsof/proc）負荷に依存させず、resolverが実際に返すancestryへ
  // 一致するpathを返すDI fakeで固定する。実FD kernel検証はintegration testへ分離済み。
  function reader(
    root: string,
    options: { processReader?: ExternalRuntimeGenerationProcessIdentityReader; laneName?: string } = {},
  ): NodeExternalRuntimeGenerationReader {
    const { processReader = new FakeProcessIdentityReader(), laneName = "even-shared" } = options;
    const resolution = resolveExternalRuntimeGenerationRoot({ env: { HERMES_HOME: root }, accountHome: "/unused", uid });
    if (!resolution.ok) throw new Error("reader fixture root の解決に失敗しました");
    const laneDirectory = join(root, laneName);
    const statusPath = join(laneDirectory, "external-runtime-generation-status.json");
    const expectedOpenedPaths = [...resolution.ancestry.map((entry) => entry.path), laneDirectory, statusPath];
    const openedPathReader: ExternalRuntimeGenerationOpenedPathReader = {
      async read(fds): Promise<ReadonlyMap<number, string> | null> {
        if (fds.length !== expectedOpenedPaths.length) return null;
        return new Map(fds.map((fd, index) => [fd, expectedOpenedPaths[index]!]));
      },
    };
    return new NodeExternalRuntimeGenerationReader({
      root: resolution,
      endpoints: { codex: ORIGIN, claude: CLAUDE_ORIGIN },
      processIdentityReader: processReader,
      openedPathReader,
    });
  }

  function writeStatus(path: string, value: unknown): void {
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  it("O_NOFOLLOW相当のbounded read後、response/status/process/endpoint exact matchを返す", async () => {
    const fixture = fixtureRoot();
    const running = runningStatus();
    writeStatus(fixture.statusPath, running.status);
    await expect(reader(fixture.root).read("codex", NOW, running.attestation)).resolves.toMatchObject({
      state: "valid",
      launchAttestation: { identity: { generationId: "1".repeat(32) } },
    });
  });

  it("opened fdのkernel pathがallowlist外なら途中component差替えとして拒否する", async () => {
    const fixture = fixtureRoot();
    const running = runningStatus();
    writeStatus(fixture.statusPath, running.status);
    const openedPathReader: ExternalRuntimeGenerationOpenedPathReader = {
      read: async (fds): Promise<ReadonlyMap<number, string>> => new Map(fds.map((fd) => [
        fd,
        join(fixture.root, "outside", "external-runtime-generation-status.json"),
      ])),
    };
    const guardedReader = new NodeExternalRuntimeGenerationReader({
      root: resolveExternalRuntimeGenerationRoot({
        env: { HERMES_HOME: fixture.root },
        accountHome: "/unused",
        uid,
      }),
      endpoints: { codex: ORIGIN, claude: CLAUDE_ORIGIN },
      processIdentityReader: new FakeProcessIdentityReader(),
      openedPathReader,
    });
    await expect(guardedReader.read("codex", NOW, running.attestation)).resolves.toEqual({
      state: "unknown",
      code: "path_invalid",
    });
  });

  // lane directory fdを保持したread中の途中component差替え（実kernel検証）は
  // external-runtime-generation-reader.integration.test.ts へ分離した。

  it("host起動時に固定したroot inodeが同一path上で差し替わった場合も拒否する", async () => {
    const fixture = fixtureRoot();
    const guardedReader = reader(fixture.root);
    const displacedRoot = `${fixture.root}-displaced`;
    roots.push(displacedRoot);
    renameSync(fixture.root, displacedRoot);
    mkdirSync(fixture.root, { mode: 0o700 });
    mkdirSync(join(fixture.root, "even-shared"), { mode: 0o700 });
    writeStatus(
      join(fixture.root, "even-shared", "external-runtime-generation-status.json"),
      runningStatus().status,
    );
    await expect(guardedReader.read("codex", NOW)).resolves.toEqual({
      state: "unknown",
      code: "path_invalid",
    });
  });

  it("host起動後にroot modeが別のvalid modeへdriftしてもsnapshot不一致として拒否する", async () => {
    const fixture = fixtureRoot();
    const guardedReader = reader(fixture.root);
    writeStatus(fixture.statusPath, runningStatus().status);
    chmodSync(fixture.root, 0o500);
    try {
      await expect(guardedReader.read("codex", NOW)).resolves.toEqual({
        state: "unknown",
        code: "path_invalid",
      });
    } finally {
      chmodSync(fixture.root, 0o700);
    }
  });

  it("Claude laneもallowlist pathとeffective runtime model sourceで同じbounded readを通る", async () => {
    const fixture = fixtureRoot("even-claude");
    const running = claudeRunningStatus();
    writeStatus(fixture.statusPath, running.status);
    await expect(
      reader(fixture.root, { laneName: "even-claude" }).read("claude", NOW, running.attestation),
    ).resolves.toMatchObject({
      state: "valid",
      launchAttestation: {
        provider: "claude",
        lane: "even-claude",
        identity: { modelReadbackSource: "claude-runtime-model" },
      },
    });
  });

  it("top-level status expiry後もunexpired terminal transitionは読み取るがlaunchには使わない", async () => {
    const fixture = fixtureRoot();
    writeStatus(fixture.statusPath, stoppedStatus());
    await expect(reader(fixture.root).read("codex", NOW)).resolves.toMatchObject({ state: "valid" });
    await expect(reader(fixture.root).read("codex", NOW, runningStatus().attestation)).resolves.toEqual({
      state: "unknown",
      code: "attestation_stale",
    });
  });

  it.each(["running", "unknown"] as const)(
    "stale top-levelのunexpired %s transitionをdurable sampleとして受理しない",
    async (state) => {
      const fixture = fixtureRoot();
      writeStatus(fixture.statusPath, staleNonTerminalStatus(state));
      await expect(reader(fixture.root).read("codex", NOW)).resolves.toEqual({
        state: "unknown",
        code: "status_stale",
      });
    },
  );

  it("stale top-levelの期限切れterminal transitionをdurable sampleとして受理しない", async () => {
    const fixture = fixtureRoot();
    writeStatus(
      fixture.statusPath,
      stoppedStatus(NOW - EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS - 1),
    );
    await expect(reader(fixture.root).read("codex", NOW)).resolves.toEqual({
      state: "unknown",
      code: "status_stale",
    });
  });

  it("missing/partial/oversize/mode/symlink/root mismatchをretryやrepair無しでunknownにする", async () => {
    const missing = fixtureRoot();
    await expect(reader(missing.root).read("codex", NOW)).resolves.toEqual({ state: "unknown", code: "missing" });

    const partial = fixtureRoot();
    writeStatus(partial.statusPath, '{"schema":');
    await expect(reader(partial.root).read("codex", NOW)).resolves.toEqual({
      state: "unknown", code: "payload_invalid",
    });

    const oversize = fixtureRoot();
    writeStatus(oversize.statusPath, "x".repeat(1024 * 1024 + 1));
    await expect(reader(oversize.root).read("codex", NOW)).resolves.toEqual({
      state: "unknown", code: "size_invalid",
    });

    const mode = fixtureRoot();
    writeStatus(mode.statusPath, runningStatus().status);
    chmodSync(mode.statusPath, 0o644);
    await expect(reader(mode.root).read("codex", NOW)).resolves.toEqual({
      state: "unknown", code: "file_invalid",
    });

    const rootMode = fixtureRoot();
    const rootModeReader = reader(rootMode.root);
    writeStatus(rootMode.statusPath, runningStatus().status);
    chmodSync(rootMode.root, 0o720);
    await expect(rootModeReader.read("codex", NOW)).resolves.toEqual({
      state: "unknown", code: "path_invalid",
    });

    const symlink = fixtureRoot();
    const target = join(symlink.root, "target.json");
    writeStatus(target, runningStatus().status);
    symlinkSync(target, symlink.statusPath);
    await expect(reader(symlink.root).read("codex", NOW)).resolves.toEqual({
      state: "unknown", code: "path_invalid",
    });

    const owner = fixtureRoot();
    writeStatus(owner.statusPath, runningStatus().status);
    const ownerResolution = resolveExternalRuntimeGenerationRoot({
      env: { HERMES_HOME: owner.root }, accountHome: "/unused", uid,
    });
    if (!ownerResolution.ok) throw new Error("owner fixture root の解決に失敗しました");
    const ownerReader = new NodeExternalRuntimeGenerationReader({
      root: {
        ...ownerResolution,
        uid: uid + 1,
      },
      endpoints: { codex: ORIGIN, claude: CLAUDE_ORIGIN },
    });
    await expect(ownerReader.read("codex", NOW)).resolves.toEqual({ state: "unknown", code: "root_invalid" });
  });

  it("provider/lane mismatch、stale、endpoint/process mismatchを保存可能sampleへ昇格しない", async () => {
    const mismatch = fixtureRoot();
    writeStatus(mismatch.statusPath, { ...runningStatus().status, provider: "claude" });
    await expect(reader(mismatch.root).read("codex", NOW)).resolves.toEqual({
      state: "unknown", code: "payload_invalid",
    });

    const endpoint = fixtureRoot();
    const endpointFixture = runningStatus("sha256:" + "f".repeat(64));
    writeStatus(endpoint.statusPath, endpointFixture.status);
    await expect(reader(endpoint.root).read("codex", NOW, endpointFixture.attestation)).resolves.toEqual({
      state: "unknown", code: "endpoint_mismatch",
    });

    const process = fixtureRoot();
    const processFixture = runningStatus();
    writeStatus(process.statusPath, processFixture.status);
    const processReader = new FakeProcessIdentityReader();
    processReader.values.set(202, null);
    await expect(
      reader(process.root, { processReader }).read("codex", NOW, processFixture.attestation),
    ).resolves.toEqual({
      state: "unknown", code: "process_mismatch",
    });
  });
});
