import { describe, expect, it } from "vitest";
import type {
  CommandRunner,
  CommandRunnerResult,
} from "./docker-host-resource-adapter.js";
import { DockerHostResourceAdapter } from "./docker-host-resource-adapter.js";
import {
  COMPOSE_LABELS,
  HACHI_LABELS,
  HostResourceAdapterError,
} from "./host-resource-adapter.js";

// === FakeCommandRunner ===

/** テスト用コマンド実行器。レスポンスを事前設定し、実行履歴を記録する */
class FakeCommandRunner implements CommandRunner {
  private readonly responses: Array<{
    match: (argv: readonly string[]) => boolean;
    result: CommandRunnerResult;
  }> = [];
  private readonly queue: CommandRunnerResult[] = [];
  private readonly commandHistory: string[][] = [];

  /** 実行されたコマンド履歴 */
  get history(): ReadonlyArray<readonly string[]> {
    return this.commandHistory;
  }

  /** 特定のコマンドに対するレスポンスを設定 */
  onCommand(match: (argv: readonly string[]) => boolean, result: CommandRunnerResult): void {
    this.responses.push({ match, result });
  }

  /** 次のコマンドの結果を順番に設定（FIFO） */
  onNext(result: CommandRunnerResult): void {
    this.queue.push(result);
  }

  async run(argv: readonly string[]): Promise<CommandRunnerResult> {
    this.commandHistory.push([...argv]);
    // マッチングレスポンスを検索
    for (const { match, result } of this.responses) {
      if (match(argv)) return result;
    }
    // キューから取得
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    // デフォルト: コマンド未設定
    return { exitCode: 127, stdout: "", stderr: "command not configured in fake" };
  }
}

// === テストヘルパー ===

/** managed container/network に必要な全ラベルを生成する */
function managedLabels(overrides?: Record<string, string>): Record<string, string> {
  return {
    [HACHI_LABELS.MANAGED]: "true",
    [HACHI_LABELS.EPHEMERAL]: "true",
    [HACHI_LABELS.PROVENANCE_VERSION]: "1",
    [HACHI_LABELS.LEASE_ID]: "lease-001",
    [HACHI_LABELS.OBJECT_FENCE]: "1",
    [HACHI_LABELS.BOARD]: "dev",
    [HACHI_LABELS.TASK_ID]: "t_test001",
    [HACHI_LABELS.RUN_ID]: "",
    [HACHI_LABELS.ORCHESTRATOR_ID]: "orch-001",
    [HACHI_LABELS.REPO_COMMON_DIR_HASH]: "a".repeat(64),
    [HACHI_LABELS.WORKTREE_HASH]: "b".repeat(64),
    [HACHI_LABELS.BUNDLE_KIND]: "worktree_postgres",
    [HACHI_LABELS.ROLLOUT_GENERATION]: "1",
    ...overrides,
  };
}

function composeContainerLabels(
  project = "hachi_lease001",
  overrides?: Record<string, string>,
): Record<string, string> {
  return managedLabels({
    [COMPOSE_LABELS.PROJECT]: project,
    [COMPOSE_LABELS.SERVICE]: "postgres",
    [COMPOSE_LABELS.CONTAINER_NUMBER]: "1",
    [COMPOSE_LABELS.ONEOFF]: "False",
    [COMPOSE_LABELS.VERSION]: "2.39.1",
    ...overrides,
  });
}

/** 64 文字の hex ID をダミー生成する */
function dummyId(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

const BUILT_IN_BRIDGE_ID = "f".repeat(64);

/** Docker inspect JSON（container）を生成するヘルパー */
function containerInspectJson(options: {
  id: string;
  running?: boolean;
  healthy?: string; // "healthy" | "unhealthy" | "starting" | undefined（ヘルスチェックなし）
  omitHealth?: boolean;
  labels?: Record<string, string>;
  portMappings?: Array<{ containerPort: number; hostIp: string; hostPort: string }>;
  networkIds?: string[];
  networkEntries?: Record<string, string>;
}): string {
  const running = options.running ?? true;

  // State 構築
  const state: Record<string, unknown> = { Running: running };
  if (options.omitHealth !== true) {
    state["Health"] = { Status: options.healthy ?? "healthy" };
  }

  // ラベル構築
  const labels = options.labels ?? {};

  // Ports 構築
  const ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> = {};
  if (options.portMappings !== undefined) {
    for (const pm of options.portMappings) {
      const key = `${String(pm.containerPort)}/tcp`;
      const existing = ports[key];
      if (existing !== undefined && existing !== null) {
        existing.push({ HostIp: pm.hostIp, HostPort: pm.hostPort });
      } else {
        ports[key] = [{ HostIp: pm.hostIp, HostPort: pm.hostPort }];
      }
    }
  }

  // Networks 構築
  const networks: Record<string, { NetworkID: string }> = {};
  if (options.networkEntries !== undefined) {
    for (const [name, networkId] of Object.entries(options.networkEntries)) {
      networks[name] = { NetworkID: networkId };
    }
  } else if (options.networkIds === undefined) {
    networks["bridge"] = { NetworkID: BUILT_IN_BRIDGE_ID };
  } else {
    for (let i = 0; i < options.networkIds.length; i++) {
      const netId = options.networkIds[i]!;
      networks[`net-${String(i)}`] = { NetworkID: netId };
    }
  }

  const json: Record<string, unknown> = {
    Id: options.id,
    State: state,
    Config: { Labels: labels },
    NetworkSettings: { Ports: ports, Networks: networks },
  };

  return JSON.stringify(json);
}

/** Docker network inspect JSON を生成するヘルパー（配列形式） */
function networkInspectJson(options: {
  id: string;
  name?: string;
  driver?: string;
  labels?: Record<string, string>;
  containerIds?: string[];
}): string {
  const containers: Record<string, unknown> = {};
  if (options.containerIds !== undefined) {
    for (const cId of options.containerIds) {
      containers[cId] = { Name: "some-container" };
    }
  }

  const entry: Record<string, unknown> = {
    Id: options.id,
    Name: options.name ?? "test-net",
    Driver: options.driver ?? "bridge",
    Labels: options.labels ?? {},
    Containers: containers,
  };

  return JSON.stringify([entry]);
}

// === 定数 ===

const SCOPE = "default";

/** テスト用アダプターを作成する */
function createAdapter(
  runner: FakeCommandRunner,
  opts?: { dockerContext?: string; healthSleep?: (delayMs: number) => Promise<void> },
): DockerHostResourceAdapter {
  return new DockerHostResourceAdapter({
    commandRunner: runner,
    dockerContext: opts?.dockerContext ?? SCOPE,
    healthSleep: opts?.healthSleep ?? (async () => Promise.resolve()),
  });
}

// === provisionContainer ===

describe("provisionContainer", () => {
  it("正常な provision で create → start → inspect のコマンド順序を検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(1);

    // create → ID を返す
    runner.onNext({ exitCode: 0, stdout: `${id}\n`, stderr: "" });
    // start → 成功
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    // inspect → JSON を返す
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        running: true,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49152" }],
      }),
      stderr: "",
    });

    const result = await adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      env: { POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password" },
      readOnlyBindMounts: [{
        sourcePath: "/var/lib/hachi/runtime-secrets/lease/postgres-password",
        targetPath: "/run/secrets/postgres-password",
      }],
      exposePorts: [5432],
    });

    // 結果の検証
    expect(result.nativeId).toBe(id);
    expect(result.healthy).toBe(true);
    expect(result.portMappings).toHaveLength(1);
    expect(result.portMappings[0]!.containerPort).toBe(5432);
    expect(result.portMappings[0]!.hostIp).toBe("127.0.0.1");
    expect(result.portMappings[0]!.hostPort).toBe(49152);

    // コマンド順序の検証
    expect(runner.history).toHaveLength(3);
    expect(runner.history[0]!).toContain("create");
    expect(runner.history[0]!).toContain("type=bind,src=/var/lib/hachi/runtime-secrets/lease/postgres-password,dst=/run/secrets/postgres-password,readonly");
    expect(runner.history[0]!).toContain("POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password");
    expect(runner.history[1]!).toContain("start");
    expect(runner.history[2]!).toContain("inspect");
  });

  it("networkId 未指定時は fresh inspect で built-in bridge だけへの attachment を要求する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(401);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49153" }],
        networkEntries: {},
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
    })).rejects.toMatchObject({ code: "inspect_failed" });
  });

  it("argv にシェル文字列がなく --label フラグが正しいことを検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(2);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49200" }],
      }),
      stderr: "",
    });

    await adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
    });

    // create コマンドの argv を検証
    const createCmd = runner.history[0]!;
    // シェルメタ文字（|, &&, ;, `, $()）が含まれていないことを確認
    for (const arg of createCmd) {
      expect(arg).not.toMatch(/[|;&`]|\$\(/);
    }

    // 各ラベルが --label key=value 形式で渡されていることを確認
    for (const [key, value] of Object.entries(labels)) {
      const labelIdx = createCmd.indexOf("--label");
      expect(labelIdx).toBeGreaterThanOrEqual(0);
      const labelPair = `${key}=${value}`;
      expect(createCmd).toContain(labelPair);
    }
  });

  it("port 0 相当の ephemeral binding で 127.0.0.1 のみ許可されることを検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(3);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49300" }],
      }),
      stderr: "",
    });

    const result = await adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
    });

    // create コマンドの -p フラグを検証
    const createCmd = runner.history[0]!;
    const pIdx = createCmd.indexOf("-p");
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(createCmd[pIdx + 1]).toBe("127.0.0.1::5432");

    // 結果のポートマッピングが 127.0.0.1 であることを検証
    expect(result.portMappings[0]!.hostIp).toBe("127.0.0.1");
  });

  it("wildcard 0.0.0.0 binding の docker inspect 結果で fail-closed する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(4);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    // inspect が 0.0.0.0 バインディングを返す
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "0.0.0.0", hostPort: "49400" }],
      }),
      stderr: "",
    });

    await expect(
      adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    try {
      // 再実行して code を検証（キューは空なので onCommand で設定）
      const runner2 = new FakeCommandRunner();
      const adapter2 = createAdapter(runner2);
      runner2.onNext({ exitCode: 0, stdout: id, stderr: "" });
      runner2.onNext({ exitCode: 0, stdout: id, stderr: "" });
      runner2.onNext({
        exitCode: 0,
        stdout: containerInspectJson({
          id,
          labels,
          portMappings: [{ containerPort: 5432, hostIp: "0.0.0.0", hostPort: "49400" }],
        }),
        stderr: "",
      });
      await adapter2.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });
    } catch (e) {
      expect((e as HostResourceAdapterError).code).toBe("wildcard_bind");
    }
  });

  it("複数 binding per port の docker inspect 結果で fail-closed する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(5);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    // 同一ポートに複数バインディング
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [
          { containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49500" },
          { containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49501" },
        ],
      }),
      stderr: "",
    });

    await expect(
      adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      }),
    ).rejects.toThrow(HostResourceAdapterError);
  });

  it("binding 欠落の docker inspect 結果で fail-closed する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(6);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    // exposePorts に 5432 を指定するが、inspect 結果にバインディングがない
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [], // バインディングなし
      }),
      stderr: "",
    });

    await expect(
      adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      }),
    ).rejects.toThrow(HostResourceAdapterError);
  });

  it.each(["start", "inspect"] as const)(
    "create 後の %s 失敗で作成済み exact identity を返す",
    async (failedStep) => {
      const runner = new FakeCommandRunner();
      const adapter = createAdapter(runner);
      const labels = managedLabels();
      const id = dummyId(failedStep === "start" ? 301 : 302);

      runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
      if (failedStep === "start") {
        runner.onNext({ exitCode: 1, stdout: "", stderr: "start failed" });
      } else {
        runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
        runner.onNext({ exitCode: 1, stdout: "", stderr: "inspect failed" });
      }

      await expect(adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      })).rejects.toMatchObject({
        createdResource: {
          kind: "docker_container",
          nativeId: id,
          scopeKey: SCOPE,
          labels,
        },
      });
      expect(runner.history.some((argv) => argv.includes("rm"))).toBe(false);
    },
  );

  it("health=starting を bounded polling し、healthy 後に返す", async () => {
    const runner = new FakeCommandRunner();
    const sleepCalls: number[] = [];
    const adapter = createAdapter(runner, {
      healthSleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
    });
    const labels = managedLabels();
    const id = dummyId(303);
    const inspectBase = {
      id,
      labels,
      portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49701" }],
    };

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({ ...inspectBase, healthy: "starting" }),
      stderr: "",
    });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({ ...inspectBase, healthy: "healthy" }),
      stderr: "",
    });

    const result = await adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
      healthCheck: {
        command: ["pg_isready"],
        intervalMs: 250,
        timeoutMs: 1000,
        retries: 3,
      },
    });

    expect(result.nativeId).toBe(id);
    expect(sleepCalls).toEqual([250]);
    expect(runner.history.filter((argv) => argv.includes("inspect"))).toHaveLength(2);
  });

  it("health=starting が polling 上限まで続く場合は exact identity 付きで拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(304);
    const starting = containerInspectJson({
      id,
      labels,
      healthy: "starting",
      portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49702" }],
    });

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      runner.onNext({ exitCode: 0, stdout: starting, stderr: "" });
    }

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
      healthCheck: {
        command: ["pg_isready"],
        intervalMs: 100,
        timeoutMs: 1000,
        retries: 2,
      },
    })).rejects.toMatchObject({
      code: "unhealthy",
      createdResource: { nativeId: id },
    });
    expect(runner.history.filter((argv) => argv.includes("inspect"))).toHaveLength(3);
  });

  it("unhealthy な docker inspect 結果を fail-closed で拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(7);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        healthy: "unhealthy",
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49700" }],
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
      healthCheck: {
        command: ["pg_isready"],
        intervalMs: 1000,
        timeoutMs: 5000,
        retries: 3,
      },
    })).rejects.toMatchObject({ code: "unhealthy" });
  });

  it("State.Health が欠落する inspect を未検証成功にせず fail-closed で拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(405);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        omitHealth: true,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49703" }],
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels,
      exposePorts: [5432],
    })).rejects.toMatchObject({
      code: "unhealthy",
      createdResource: { nativeId: id },
    });
  });

  it("malformed inspect JSON で HostResourceAdapterError をスローする", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(8);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    // 不正な JSON
    runner.onNext({
      exitCode: 0,
      stdout: "this is not valid json{{{",
      stderr: "",
    });

    await expect(
      adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      }),
    ).rejects.toThrow(HostResourceAdapterError);
  });

  it("required labels 不足の provision を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    // MANAGED ラベルを除外
    const labels = managedLabels();
    delete labels[HACHI_LABELS.MANAGED];

    await expect(
      adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    // コマンドが一切実行されていないことを確認（バリデーションで即拒否）
    expect(runner.history).toHaveLength(0);
  });
});

// === provisionNetwork ===

describe("provisionNetwork", () => {
  it("usage を完全に検証できない任意 network driver を create 前に拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(adapter.provisionNetwork({
      scopeKey: SCOPE,
      name: "hachi-overlay",
      labels: managedLabels(),
      driver: "overlay",
    })).rejects.toMatchObject({ code: "inspect_failed" });
    expect(runner.history).toHaveLength(0);
  });

  it("正常な provision で network create → network inspect のコマンド順序を検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(10);

    // network create → ID を返す
    runner.onNext({ exitCode: 0, stdout: `${id}\n`, stderr: "" });
    // network inspect → JSON 配列を返す
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({ id, name: "hachi-test-net", labels }),
      stderr: "",
    });

    const result = await adapter.provisionNetwork({
      scopeKey: SCOPE,
      name: "hachi-test-net",
      labels,
    });

    expect(result.nativeId).toBe(id);
    for (const [key, value] of Object.entries(labels)) {
      expect(result.labels[key]).toBe(value);
    }

    // コマンド順序の検証
    expect(runner.history).toHaveLength(2);
    const createCmd = runner.history[0]!;
    expect(createCmd).toContain("network");
    expect(createCmd).toContain("create");
    const inspectCmd = runner.history[1]!;
    expect(inspectCmd).toContain("network");
    expect(inspectCmd).toContain("inspect");
  });

  it("network create 後の inspect 失敗で作成済み exact identity を返す", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(305);
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 1, stdout: "", stderr: "inspect failed" });

    await expect(adapter.provisionNetwork({
      scopeKey: SCOPE,
      name: "hachi-test-net",
      labels,
    })).rejects.toMatchObject({
      createdResource: {
        kind: "docker_network",
        nativeId: id,
        scopeKey: SCOPE,
        labels,
      },
    });
    expect(runner.history.some((argv) => argv.includes("rm"))).toBe(false);
  });

  it("ラベルフラグの正しさを検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(11);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({ id, name: "hachi-test-net", labels }),
      stderr: "",
    });

    await adapter.provisionNetwork({
      scopeKey: SCOPE,
      name: "hachi-test-net",
      labels,
    });

    // create コマンドの --label フラグを検証
    const createCmd = runner.history[0]!;
    for (const [key, value] of Object.entries(labels)) {
      const labelPair = `${key}=${value}`;
      expect(createCmd).toContain(labelPair);
    }

    // --driver フラグがデフォルト bridge であることを検証
    const driverIdx = createCmd.indexOf("--driver");
    expect(driverIdx).toBeGreaterThanOrEqual(0);
    expect(createCmd[driverIdx + 1]).toBe("bridge");
  });

  it("malformed inspect JSON で拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const labels = managedLabels();
    const id = dummyId(12);

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    // 不正な JSON
    runner.onNext({
      exitCode: 0,
      stdout: "not json at all!!!",
      stderr: "",
    });

    await expect(
      adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "hachi-test-net",
        labels,
      }),
    ).rejects.toThrow(HostResourceAdapterError);
  });
});

// === inspectContainer ===

describe("inspectContainer", () => {
  it.each([
    ["malformed key", { "5432": [{ HostIp: "127.0.0.1", HostPort: "49152" }] }, "inspect_failed"],
    ["wildcard bind", { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "49152" }] }, "wildcard_bind"],
  ] as const)("%s を public inspect で fail-closed に拒否する", async (_name, ports, code) => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(402);
    runner.onNext({
      exitCode: 0,
      stdout: JSON.stringify({
        Id: id,
        State: { Running: true },
        Config: { Labels: managedLabels() },
        NetworkSettings: {
          Ports: ports,
          Networks: { bridge: { NetworkID: BUILT_IN_BRIDGE_ID } },
        },
      }),
      stderr: "",
    });

    await expect(adapter.inspectContainer(id, SCOPE)).rejects.toMatchObject({ code });
  });

  it("短縮 ID を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.inspectContainer("abc123def456", SCOPE),
    ).rejects.toThrow(HostResourceAdapterError);

    // コマンドが実行されていないことを確認
    expect(runner.history).toHaveLength(0);
  });

  it("名前文字列を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.inspectContainer("my-container-name", SCOPE),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("空文字を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.inspectContainer("", SCOPE),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("正常な inspect で JSON パース、ポートマッピング抽出、ネットワーク ID 抽出を行う", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(20);
    const labels = managedLabels();
    const netId = dummyId(30);

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({
          id,
          running: true,
          healthy: "healthy",
          labels,
          portMappings: [
            { containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49200" },
            { containerPort: 8080, hostIp: "127.0.0.1", hostPort: "49201" },
          ],
          networkIds: [netId],
        }),
        stderr: "",
      },
    );

    const inspection = await adapter.inspectContainer(id, SCOPE);

    expect(inspection).not.toBeNull();
    expect(inspection!.nativeId).toBe(id);
    expect(inspection!.scopeKey).toBe(SCOPE);
    expect(inspection!.running).toBe(true);
    expect(inspection!.healthy).toBe(true);

    // ポートマッピングの検証
    expect(inspection!.portMappings).toHaveLength(2);
    expect(inspection!.portMappings[0]!.containerPort).toBe(5432);
    expect(inspection!.portMappings[0]!.hostIp).toBe("127.0.0.1");
    expect(inspection!.portMappings[0]!.hostPort).toBe(49200);
    expect(inspection!.portMappings[1]!.containerPort).toBe(8080);
    expect(inspection!.portMappings[1]!.hostPort).toBe(49201);

    // ネットワーク ID の検証
    expect(inspection!.networkIds).toContain(netId);

    // ラベルの検証
    for (const [key, value] of Object.entries(labels)) {
      expect(inspection!.labels[key]).toBe(value);
    }
  });

  it("存在しない container は null を返す（exit code 1）", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(404);

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      { exitCode: 1, stdout: "", stderr: `Error: No such object: ${dummyId(30)}` },
    );

    const result = await adapter.inspectContainer(id, SCOPE);
    expect(result).toBeNull();
  });
});

// === inspectNetwork ===

describe("inspectNetwork", () => {
  it("短縮 ID を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.inspectNetwork("abc123def456", SCOPE),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("名前文字列を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.inspectNetwork("my-network-name", SCOPE),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("空文字を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.inspectNetwork("", SCOPE),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("正常な inspect で JSON パース、接続 container 抽出を行う", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(40);
    const containerId1 = dummyId(41);
    const containerId2 = dummyId(42);
    const labels = managedLabels();

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(netId),
      {
        exitCode: 0,
        stdout: networkInspectJson({
          id: netId,
          name: "hachi-net",
          driver: "bridge",
          labels,
          containerIds: [containerId1, containerId2],
        }),
        stderr: "",
      },
    );

    const inspection = await adapter.inspectNetwork(netId, SCOPE);

    expect(inspection).not.toBeNull();
    expect(inspection!.nativeId).toBe(netId);
    expect(inspection!.scopeKey).toBe(SCOPE);
    expect(inspection!.driver).toBe("bridge");
    expect(inspection!.isBuiltInBridge).toBe(false);

    // 接続 container の検証
    expect(inspection!.connectedContainerIds).toHaveLength(2);
    expect(inspection!.connectedContainerIds).toContain(containerId1);
    expect(inspection!.connectedContainerIds).toContain(containerId2);

    // ラベルの検証
    for (const [key, value] of Object.entries(labels)) {
      expect(inspection!.labels[key]).toBe(value);
    }
  });

  it("built-in bridge を検出する（name='bridge', driver='bridge'）", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const bridgeId = dummyId(50);

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(bridgeId),
      {
        exitCode: 0,
        stdout: networkInspectJson({
          id: bridgeId,
          name: "bridge",
          driver: "bridge",
        }),
        stderr: "",
      },
    );

    const inspection = await adapter.inspectNetwork(bridgeId, SCOPE);

    expect(inspection).not.toBeNull();
    expect(inspection!.isBuiltInBridge).toBe(true);
  });

  it("存在しない network は null を返す", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(404);

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(netId),
      { exitCode: 1, stdout: "", stderr: "Error: No such network" },
    );

    const result = await adapter.inspectNetwork(netId, SCOPE);
    expect(result).toBeNull();
  });
});

// === removeContainer ===

describe("removeContainer", () => {
  it("短縮 ID を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.removeContainer({
        nativeId: "abc123def456",
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-short",
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("空/部分 expectedLabels を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    // 空の expectedLabels
    await expect(
      adapter.removeContainer({
        nativeId: dummyId(1),
        scopeKey: SCOPE,
        expectedLabels: {},
        executionNonce: "nonce-empty",
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    // managed=true のみの部分ラベル
    await expect(
      adapter.removeContainer({
        nativeId: dummyId(1),
        scopeKey: SCOPE,
        expectedLabels: { [HACHI_LABELS.MANAGED]: "true" },
        executionNonce: "nonce-partial",
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    // バリデーションで即拒否されるのでコマンドは実行されない
    expect(runner.history).toHaveLength(0);
  });

  it("正常な remove で inspect → rm -f のコマンド順序、完全 ID が argv に渡ることを検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(60);
    const labels = managedLabels();

    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        running: true,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49600" }],
      }),
      stderr: "",
    });
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({
        id: BUILT_IN_BRIDGE_ID,
        name: "bridge",
        driver: "bridge",
      }),
      stderr: "",
    });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 1, stdout: "", stderr: "Error: No such container" });

    const result = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-remove",
    });

    expect(result.status).toBe("removed");
    expect(result.nativeId).toBe(id);

    // コマンド順序の検証: container inspect → attachment inspect → rm -f
    expect(runner.history.length).toBeGreaterThanOrEqual(3);
    const inspectCmd = runner.history[0]!;
    expect(inspectCmd).toContain("inspect");
    expect(inspectCmd).toContain(id);

    const attachmentInspectCmd = runner.history[1]!;
    expect(attachmentInspectCmd).toContain("network");
    expect(attachmentInspectCmd).toContain(BUILT_IN_BRIDGE_ID);

    const rmCmd = runner.history[2]!;
    expect(rmCmd).toContain("rm");
    expect(rmCmd).toContain("-f");
    expect(rmCmd).toContain(id);
    expect(runner.history.filter((cmd) => cmd.includes("inspect"))).toHaveLength(3);
  });

  it("rm 成功後も同じ exact ID が存在する場合は removed を返さない", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(403);
    const labels = managedLabels();
    const present = {
      exitCode: 0,
      stdout: containerInspectJson({ id, labels }),
      stderr: "",
    };
    runner.onNext(present);
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({
        id: BUILT_IN_BRIDGE_ID,
        name: "bridge",
        driver: "bridge",
      }),
      stderr: "",
    });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext(present);

    await expect(adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-still-present",
    })).rejects.toMatchObject({ code: "inspect_failed" });
  });

  it("docker rm の非ゼロ終了は恒久 ID 不整合ではなく retryable inspect failure にする", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(408);
    const labels = managedLabels();
    runner.onNext({ exitCode: 0, stdout: containerInspectJson({ id, labels }), stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({ id: BUILT_IN_BRIDGE_ID, name: "bridge", driver: "bridge" }),
      stderr: "",
    });
    runner.onNext({ exitCode: 1, stdout: "", stderr: "daemon unavailable" });

    await expect(adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-rm-transient",
    })).rejects.toMatchObject({ code: "inspect_failed" });
  });

  it("label 不一致で fail-closed する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(61);
    const actualLabels = managedLabels({ [HACHI_LABELS.TASK_ID]: "t_actual" });
    const expectedLabels = managedLabels({ [HACHI_LABELS.TASK_ID]: "t_wrong" });

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({
          id,
          running: true,
          labels: actualLabels,
          portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49700" }],
        }),
        stderr: "",
      },
    );

    const result = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels,
      executionNonce: "nonce-mismatch",
    });

    expect(result.status).toBe("label_mismatch");
    expect(result.failureDetail).toBeDefined();

    // rm コマンドが実行されていないことを確認
    const rmCommands = runner.history.filter((cmd) => cmd.includes("rm"));
    expect(rmCommands).toHaveLength(0);
  });

  it("foreign/shared network attachment drift を fresh inspect で拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(406);
    const foreignNetworkId = dummyId(407);
    const labels = managedLabels();

    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({ id, labels, networkIds: [foreignNetworkId] }),
      stderr: "",
    });
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({
        id: foreignNetworkId,
        name: "shared-network",
        labels: {},
      }),
      stderr: "",
    });

    const result = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-foreign-attachment",
    });

    expect(result.status).toBe("label_mismatch");
    expect(result.failureDetail).toContain("attachment");
    expect(runner.history.some((argv) => argv.includes("rm"))).toBe(false);
  });

  it("scope/context 不一致（inspect が exit 1）で already_absent を返す", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(62);

    // inspect が exit 1（存在しない）
    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      { exitCode: 1, stdout: "", stderr: "Error: No such container" },
    );

    const result = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-absent",
    });

    expect(result.status).toBe("already_absent");
    expect(result.nativeId).toBe(id);
  });

  it("Hachi label 不一致（managed が true でない）で label_mismatch を返す", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(63);
    // 実際の container は managed=false
    const actualLabels = managedLabels({ [HACHI_LABELS.MANAGED]: "false" });

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({
          id,
          running: true,
          labels: actualLabels,
          portMappings: [],
        }),
        stderr: "",
      },
    );

    // expectedLabels は managed=true
    const result = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-not-managed",
    });

    expect(result.status).toBe("label_mismatch");
  });
});

// === removeNetwork ===

describe("removeNetwork", () => {
  it("任意 driver network は Containers が空でも usage unknown として削除しない", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(404);
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({
        id: netId,
        name: "plugin-net",
        driver: "third-party-plugin",
        labels: managedLabels(),
        containerIds: [],
      }),
      stderr: "",
    });

    await expect(adapter.removeNetwork({
      nativeId: netId,
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-plugin",
      expectedAbsentContainerIds: [],
    })).rejects.toMatchObject({ code: "inspect_failed" });
    expect(runner.history.some((cmd) => cmd.includes("rm"))).toBe(false);
  });

  it("短縮 ID を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.removeNetwork({
        nativeId: "abc123def456",
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-short-net",
        expectedAbsentContainerIds: [],
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("空/部分 expectedLabels を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(
      adapter.removeNetwork({
        nativeId: dummyId(1),
        scopeKey: SCOPE,
        expectedLabels: {},
        executionNonce: "nonce-empty-net",
        expectedAbsentContainerIds: [],
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    await expect(
      adapter.removeNetwork({
        nativeId: dummyId(1),
        scopeKey: SCOPE,
        expectedLabels: { [HACHI_LABELS.MANAGED]: "true" },
        executionNonce: "nonce-partial-net",
        expectedAbsentContainerIds: [],
      }),
    ).rejects.toThrow(HostResourceAdapterError);

    expect(runner.history).toHaveLength(0);
  });

  it("built-in bridge の削除を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const bridgeId = dummyId(70);

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(bridgeId),
      {
        exitCode: 0,
        stdout: networkInspectJson({
          id: bridgeId,
          name: "bridge",
          driver: "bridge",
          labels: managedLabels(),
        }),
        stderr: "",
      },
    );

    const result = await adapter.removeNetwork({
      nativeId: bridgeId,
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-bridge",
      expectedAbsentContainerIds: [],
    });

    expect(result.status).toBe("bridge_protected");
    expect(result.failureDetail).toContain("built-in bridge");
  });

  it("正常な remove で inspect → network rm のコマンド順序を検証する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(71);
    const labels = managedLabels();

    const presentNetwork = {
      exitCode: 0,
      stdout: networkInspectJson({
        id: netId,
        name: "hachi-net",
        labels,
        containerIds: [],
      }),
      stderr: "",
    };
    runner.onNext(presentNetwork);
    runner.onNext(presentNetwork);
    runner.onNext({ exitCode: 0, stdout: netId, stderr: "" });
    runner.onNext({ exitCode: 1, stdout: "", stderr: "Error: No such network" });

    const result = await adapter.removeNetwork({
      nativeId: netId,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-net-remove",
      expectedAbsentContainerIds: [],
    });

    expect(result.status).toBe("removed");
    expect(result.nativeId).toBe(netId);

    // rm コマンドに完全 ID が渡されていることを検証
    const rmCmd = runner.history.find(
      (cmd) => cmd.includes("network") && cmd.includes("rm"),
    );
    expect(rmCmd).toBeDefined();
    expect(rmCmd!).toContain(netId);
    expect(runner.history.filter((cmd) => cmd.includes("network") && cmd.includes("inspect")))
      .toHaveLength(3);
  });

  it("network rm 成功後も同じ exact ID が存在する場合は removed を返さない", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(405);
    const labels = managedLabels();
    const present = {
      exitCode: 0,
      stdout: networkInspectJson({ id: netId, name: "hachi-net", labels }),
      stderr: "",
    };
    runner.onNext(present);
    runner.onNext(present);
    runner.onNext({ exitCode: 0, stdout: netId, stderr: "" });
    runner.onNext(present);

    await expect(adapter.removeNetwork({
      nativeId: netId,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-net-still-present",
      expectedAbsentContainerIds: [],
    })).rejects.toMatchObject({ code: "inspect_failed" });
  });

  it("docker network rm の in-use race は retryable inspect failure にする", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(409);
    const labels = managedLabels();
    const present = {
      exitCode: 0,
      stdout: networkInspectJson({ id: netId, name: "hachi-net", labels }),
      stderr: "",
    };
    runner.onNext(present);
    runner.onNext(present);
    runner.onNext({ exitCode: 1, stdout: "", stderr: "network has active endpoints" });

    await expect(adapter.removeNetwork({
      nativeId: netId,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-network-race",
      expectedAbsentContainerIds: [],
    })).rejects.toMatchObject({ code: "inspect_failed" });
  });

  it("container が残存している場合に containers_remain を返す", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(72);
    const containerId = dummyId(73);
    const labels = managedLabels();

    // network inspect（接続 container あり）
    runner.onCommand(
      (argv) => argv.includes("network") && argv.includes("inspect") && argv.includes(netId),
      {
        exitCode: 0,
        stdout: networkInspectJson({
          id: netId,
          name: "hachi-net",
          labels,
          containerIds: [containerId],
        }),
        stderr: "",
      },
    );

    // expectedAbsentContainerIds の container inspect（まだ存在する）
    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(containerId) && !argv.includes("network"),
      {
        exitCode: 0,
        stdout: containerInspectJson({
          id: containerId,
          running: true,
          labels,
          portMappings: [],
        }),
        stderr: "",
      },
    );

    const result = await adapter.removeNetwork({
      nativeId: netId,
      scopeKey: SCOPE,
      expectedLabels: labels,
      executionNonce: "nonce-remain",
      expectedAbsentContainerIds: [containerId],
    });

    expect(result.status).toBe("containers_remain");
  });

  it("label 不一致で fail-closed する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const netId = dummyId(74);
    const actualLabels = managedLabels({ [HACHI_LABELS.BOARD]: "production" });
    const expectedLabels = managedLabels({ [HACHI_LABELS.BOARD]: "staging" });

    runner.onCommand(
      (argv) => argv.includes("network") && argv.includes("inspect") && argv.includes(netId),
      {
        exitCode: 0,
        stdout: networkInspectJson({
          id: netId,
          labels: actualLabels,
        }),
        stderr: "",
      },
    );

    const result = await adapter.removeNetwork({
      nativeId: netId,
      scopeKey: SCOPE,
      expectedLabels,
      executionNonce: "nonce-net-mismatch",
      expectedAbsentContainerIds: [],
    });

    expect(result.status).toBe("label_mismatch");

    // rm コマンドが実行されていないことを確認
    const rmCommands = runner.history.filter(
      (cmd) => cmd.includes("network") && cmd.includes("rm"),
    );
    expect(rmCommands).toHaveLength(0);
  });
});

// === legacy resource 保護 ===

describe("legacy resource 保護", () => {
  it("legacy（Hachi ラベルなし）container の inspect → remove 試行で label_mismatch を返す", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(80);
    // legacy container にはラベルがない
    const legacyLabels: Record<string, string> = {};

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({
          id,
          running: true,
          labels: legacyLabels,
          portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49800" }],
        }),
        stderr: "",
      },
    );

    const result = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-legacy",
    });

    expect(result.status).toBe("label_mismatch");

    // rm コマンドが実行されていないことを確認（legacy を保護）
    const rmCommands = runner.history.filter((cmd) => cmd.includes("rm"));
    expect(rmCommands).toHaveLength(0);
  });
});

// === volume 非破壊 ===

describe("volume 非破壊", () => {
  it("DockerHostResourceAdapter に removeVolume メソッドが存在しないことを確認する", () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    expect("removeVolume" in adapter).toBe(false);
  });
});

// === Docker context ===

describe("Docker context", () => {
  it("dockerContext 指定時に --context フラグが argv に含まれる", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner, { dockerContext: "remote-host" });
    const id = dummyId(90);
    const labels = managedLabels();

    // inspect コマンドを設定
    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({
          id,
          running: true,
          labels,
          portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49900" }],
        }),
        stderr: "",
      },
    );

    await adapter.inspectContainer(id, "remote-host");

    // 全てのコマンドに --context フラグが含まれていることを検証
    expect(runner.history).toHaveLength(1);
    const cmd = runner.history[0]!;
    const contextIdx = cmd.indexOf("--context");
    expect(contextIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[contextIdx + 1]).toBe("remote-host");
  });

  it("既定 helper でも scopeKey と同じ --context を常に付与する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(91);

    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({ id, labels: managedLabels() }),
        stderr: "",
      },
    );

    await adapter.inspectContainer(id, SCOPE);

    const cmd = runner.history[0]!;
    expect(cmd).toContain("--context");
    expect(cmd[cmd.indexOf("--context") + 1]).toBe(SCOPE);
  });

  it("dockerContext の省略・空文字を constructor で拒否する", () => {
    const runner = new FakeCommandRunner();
    expect(() => new DockerHostResourceAdapter({
      commandRunner: runner,
    } as never)).toThrow(HostResourceAdapterError);
    expect(() => new DockerHostResourceAdapter({
      commandRunner: runner,
      dockerContext: "",
    })).toThrow(HostResourceAdapterError);
  });

  it("dockerContext 指定時に provisionContainer の全コマンドに --context が含まれる", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner, { dockerContext: "staging-host" });
    const id = dummyId(92);
    const labels = managedLabels();

    runner.onNext({ exitCode: 0, stdout: id, stderr: "" }); // create
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" }); // start
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49950" }],
      }),
      stderr: "",
    }); // inspect

    await adapter.provisionContainer({
      scopeKey: "staging-host",
      image: "postgres:16",
      labels,
      exposePorts: [5432],
    });

    // 全 3 コマンドに --context staging-host が含まれる
    expect(runner.history).toHaveLength(3);
    for (const cmd of runner.history) {
      const contextIdx = cmd.indexOf("--context");
      expect(contextIdx).toBeGreaterThanOrEqual(0);
      expect(cmd[contextIdx + 1]).toBe("staging-host");
    }
  });

  it("固定 context と異なる scope は not-found 判定前に拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner, { dockerContext: "remote-host" });

    await expect(adapter.removeContainer({
      nativeId: dummyId(93),
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-wrong-context-before-inspect",
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(runner.history).toHaveLength(0);
  });
});

describe("exact ID・scope・inspect shape 境界", () => {
  it("adapter scope と異なる inspect/remove は command 実行前に拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(100);

    await expect(adapter.inspectContainer(id, "other-context"))
      .rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(adapter.removeNetwork({
      nativeId: id,
      scopeKey: "other-context",
      expectedLabels: managedLabels(),
      executionNonce: "nonce-wrong-context",
      expectedAbsentContainerIds: [],
    })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(runner.history).toHaveLength(0);
  });

  it("container inspect 応答の exact ID 不一致を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const requestedId = dummyId(101);
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({ id: dummyId(102), labels: managedLabels() }),
      stderr: "",
    });

    await expect(adapter.inspectContainer(requestedId, SCOPE))
      .rejects.toMatchObject({ code: "invalid_id" });
  });

  it("network inspect 応答の exact ID 不一致を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const requestedId = dummyId(103);
    runner.onNext({
      exitCode: 0,
      stdout: networkInspectJson({ id: dummyId(104), labels: managedLabels() }),
      stderr: "",
    });

    await expect(adapter.inspectNetwork(requestedId, SCOPE))
      .rejects.toMatchObject({ code: "invalid_id" });
  });

  it.each([
    ["container", "{}"],
    ["network", "[{}]"],
  ] as const)("valid JSON でも malformed %s inspect shape を拒否する", async (kind, stdout) => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(105);
    runner.onNext({ exitCode: 0, stdout, stderr: "" });

    const operation = kind === "container"
      ? adapter.inspectContainer(id, SCOPE)
      : adapter.inspectNetwork(id, SCOPE);
    await expect(operation).rejects.toBeInstanceOf(HostResourceAdapterError);
  });

  it("Docker unavailable を absent と誤認しない", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    runner.onNext({ exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" });

    await expect(adapter.inspectContainer(dummyId(106), SCOPE))
      .rejects.toMatchObject({ code: "inspect_failed" });
  });
});

describe("provision の fail-closed 再照合", () => {
  it("Compose project だけの container provenance を create 前に拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels: managedLabels({ [COMPOSE_LABELS.PROJECT]: "hachi_lease001" }),
      exposePorts: [5432],
      composeProject: "hachi_lease001",
    })).rejects.toMatchObject({ code: "missing_labels" });
    expect(runner.history).toHaveLength(0);
  });

  it("provision inspect の Compose service 不一致を exact identity 付きで拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(109);
    const expectedLabels = composeContainerLabels();
    const actualLabels = composeContainerLabels("hachi_lease001", {
      [COMPOSE_LABELS.SERVICE]: "other-service",
    });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels: actualLabels,
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49151" }],
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels: expectedLabels,
      exposePorts: [5432],
      composeProject: "hachi_lease001",
    })).rejects.toMatchObject({
      code: "label_mismatch",
      createdResource: { nativeId: id },
    });
  });

  it.each(["49152junk", "0", "65536"])("invalid actual HostPort %s を拒否する", async (hostPort) => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(110);
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels: managedLabels(),
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort }],
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels: managedLabels(),
      exposePorts: [5432],
    })).rejects.toMatchObject({ code: "invalid_port" });
  });

  it("create ID と provision inspect ID の不一致を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const createId = dummyId(111);
    runner.onNext({ exitCode: 0, stdout: createId, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: createId, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id: dummyId(112),
        labels: managedLabels(),
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49152" }],
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels: managedLabels(),
      exposePorts: [5432],
    })).rejects.toMatchObject({ code: "invalid_id" });
  });

  it("要求した exact network attachment と inspect 結果の不一致を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(113);
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({ exitCode: 0, stdout: id, stderr: "" });
    runner.onNext({
      exitCode: 0,
      stdout: containerInspectJson({
        id,
        labels: managedLabels(),
        portMappings: [{ containerPort: 5432, hostIp: "127.0.0.1", hostPort: "49153" }],
        networkIds: [dummyId(115)],
      }),
      stderr: "",
    });

    await expect(adapter.provisionContainer({
      scopeKey: SCOPE,
      image: "postgres:16",
      labels: managedLabels(),
      exposePorts: [5432],
      networkId: dummyId(114),
    })).rejects.toMatchObject({ code: "invalid_id" });
  });

  it("built-in bridge network の作成を command 実行前に拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    await expect(adapter.provisionNetwork({
      scopeKey: SCOPE,
      name: "bridge",
      labels: managedLabels(),
    })).rejects.toMatchObject({ code: "bridge_protected" });
    expect(runner.history).toHaveLength(0);
  });
});

describe("remove provenance conjunction", () => {
  it("Compose provenance expectation の省略・project/service 不一致を拒否する", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const id = dummyId(120);
    const actualLabels = composeContainerLabels();
    runner.onCommand(
      (argv) => argv.includes("inspect") && argv.includes(id),
      {
        exitCode: 0,
        stdout: containerInspectJson({ id, labels: actualLabels }),
        stderr: "",
      },
    );

    const missing = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: managedLabels(),
      executionNonce: "nonce-compose-missing",
    });
    expect(missing.status).toBe("label_mismatch");

    await expect(adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: managedLabels({ [COMPOSE_LABELS.PROJECT]: "other-project" }),
      executionNonce: "nonce-compose-partial",
    })).rejects.toMatchObject({ code: "missing_labels" });

    const wrongProject = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: composeContainerLabels("other-project"),
      executionNonce: "nonce-compose-wrong-project",
    });
    expect(wrongProject.status).toBe("label_mismatch");

    const wrongService = await adapter.removeContainer({
      nativeId: id,
      scopeKey: SCOPE,
      expectedLabels: composeContainerLabels("hachi_lease001", {
        [COMPOSE_LABELS.SERVICE]: "other-service",
      }),
      executionNonce: "nonce-compose-wrong-service",
    });
    expect(wrongService.status).toBe("label_mismatch");
    expect(runner.history.filter((argv) => argv.includes("rm"))).toHaveLength(0);
  });

  it("legacy 32 object への remove side effect が 0 件である", async () => {
    const runner = new FakeCommandRunner();
    const adapter = createAdapter(runner);
    const ids = Array.from({ length: 32 }, (_, index) => dummyId(200 + index));
    for (const id of ids) {
      runner.onCommand(
        (argv) => argv.includes("inspect") && argv.includes(id),
        { exitCode: 0, stdout: containerInspectJson({ id, labels: {} }), stderr: "" },
      );
    }

    for (const id of ids) {
      const result = await adapter.removeContainer({
        nativeId: id,
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: `nonce-legacy-${id}`,
      });
      expect(result.status).toBe("label_mismatch");
    }
    expect(runner.history.filter((argv) => argv.includes("rm"))).toHaveLength(0);
  });
});
