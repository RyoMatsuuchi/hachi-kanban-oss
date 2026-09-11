// external-runtime-generation-reader の実kernel境界（docs/contract.md §75.7）を検証するintegration test。
// semantic testsとは異なり、実FDのkernel path観測とLinux readlinkの単一2秒deadline挙動を実際のOS/
// module挙動で確認する。実kernel検証は現在実行中のhostのplatformでしか行えないため、他OSの成功は
// 主張しない（.evidence/runtime-reader-host-spec.md）。
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  NodeExternalRuntimeGenerationOpenedPathReader,
  type ExternalRuntimeGenerationOpenedPathReader,
  type ExternalRuntimeGenerationProcessIdentityReader,
} from "./external-runtime-generation-reader.js";
import { resolveExternalRuntimeGenerationRoot } from "./external-runtime-generation-root.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readlink: vi.fn(actual.readlink) };
});

const OPENED_PATH_READ_TIMEOUT_MS = 2_000;
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

function identity(): ExternalRuntimeGenerationIdentityV1 {
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
    endpointIdentityHash: externalRuntimeGenerationEndpointIdentityHash("codex", ORIGIN),
    startedAt: NOW - 10_000,
  };
}

function runningStatus(): {
  status: ExternalRuntimeGenerationStatusV1;
  attestation: ExternalRuntimeGenerationAttestationV1;
} {
  const observedAt = NOW - 1_000;
  const value = identity();
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

function readWithPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
  }
}

describe("external runtime generation opened path reader — 実kernel境界", () => {
  const roots: string[] = [];
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;

  // readlinkは既定でpassthroughへ戻す。mockResetで実装を空にすると、Darwinの実kernel testでは
  // readlinkを一切呼ばないため気づけないが、Linux実procでは同じ実kernel testがreadlinkへ委譲するため
  // test宣言順（前のtestがmockを空にしたまま）に結果が左右されてしまう。
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(readlink).mockImplementation(actual.readlink);
  });

  afterEach(() => {
    for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
    vi.mocked(readlink).mockClear();
  });

  function fixtureRoot(laneName = "even-shared"): { root: string; lane: string; statusPath: string } {
    const root = realpathSync(mkdtempSync(join(process.cwd(), ".external-reader-integration-")));
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

  function writeStatus(path: string, value: unknown): void {
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  it(
    `lane directory fdを保持したread中の途中component差替えを実kernel(${process.platform})でfail-closedにする`,
    async () => {
      const fixture = fixtureRoot();
      const running = runningStatus();
      writeStatus(fixture.statusPath, running.status);
      const displacedLane = `${fixture.lane}-displaced`;
      roots.push(displacedLane);
      const actualOpenedPathReader = new NodeExternalRuntimeGenerationOpenedPathReader();
      let replaced = false;
      const openedPathReader: ExternalRuntimeGenerationOpenedPathReader = {
        read: async (fds): Promise<ReadonlyMap<number, string> | null> => {
          const openedPaths = await actualOpenedPathReader.read(fds);
          if (!replaced && openedPaths !== null && [...openedPaths.values()].includes(fixture.lane)) {
            replaced = true;
            renameSync(fixture.lane, displacedLane);
            mkdirSync(fixture.lane, { mode: 0o700 });
            writeStatus(fixture.statusPath, running.status);
          }
          return openedPaths;
        },
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
      // path_invalidはlsof/readlink失敗でも起こり得るため、実kernelが実際にlane pathを観測して
      // renameを検知したことをreplacedで直接証明する（空振りgreenの排除）。
      expect(replaced).toBe(true);
    },
  );

  describe("Linux opened path readerのbounded deadline（node:fs/promises.readlinkをmock）", () => {
    it("readlinkが解決しない場合でも単一2秒deadlineでnullへ倒す", async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(readlink).mockImplementation(() => new Promise<string>(() => undefined));
        const opened = new NodeExternalRuntimeGenerationOpenedPathReader();
        const promise = readWithPlatform("linux", () => opened.read([11, 12]));
        await vi.advanceTimersByTimeAsync(OPENED_PATH_READ_TIMEOUT_MS);
        await expect(promise).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("期限前にreadlinkがrejectした場合はdeadlineを待たずnullへ倒す", async () => {
      vi.mocked(readlink).mockRejectedValue(new Error("ENOENT"));
      const opened = new NodeExternalRuntimeGenerationOpenedPathReader();
      await expect(readWithPlatform("linux", () => opened.read([21]))).resolves.toBeNull();
    });

    it("期限後の遅延rejectはunhandled rejectionを起こさず既に確定したnullを上書きしない", async () => {
      vi.useFakeTimers();
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        let rejectLate: ((reason: unknown) => void) | undefined;
        const late = new Promise<string>((_resolve, reject) => {
          rejectLate = reject;
        });
        vi.mocked(readlink).mockReturnValue(late);
        const opened = new NodeExternalRuntimeGenerationOpenedPathReader();
        const promise = readWithPlatform("linux", () => opened.read([31]));
        await vi.advanceTimersByTimeAsync(OPENED_PATH_READ_TIMEOUT_MS);
        await expect(promise).resolves.toBeNull();
        rejectLate?.(new Error("late-rejection"));
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await expect(promise).resolves.toBeNull();
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        vi.useRealTimers();
      }
    });

    it("期限後の遅延成功は既に確定したnullを上書きしない", async () => {
      vi.useFakeTimers();
      try {
        let resolveLate: ((value: string) => void) | undefined;
        const late = new Promise<string>((resolve) => {
          resolveLate = resolve;
        });
        vi.mocked(readlink).mockReturnValue(late);
        const opened = new NodeExternalRuntimeGenerationOpenedPathReader();
        const promise = readWithPlatform("linux", () => opened.read([41]));
        await vi.advanceTimersByTimeAsync(OPENED_PATH_READ_TIMEOUT_MS);
        await expect(promise).resolves.toBeNull();
        resolveLate?.("/late/resolved/path");
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        await expect(promise).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
