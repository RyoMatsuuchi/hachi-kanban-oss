import { describe, expect, it } from "vitest";
import { FakeHostResourceAdapter } from "./host-resource-adapter-fake.js";
import {
  COMPOSE_LABELS,
  HACHI_LABELS,
  HostResourceAdapterError,
  REQUIRED_HACHI_LABEL_KEYS,
  validateExpectedLabelsForRemoval,
  validateFullDockerIdFormat,
  validateRequiredLabels,
  verifyLabelsMatch,
} from "./host-resource-adapter.js";

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

function composeContainerLabels(project = "hachi_lease001"): Record<string, string> {
  return managedLabels({
    [COMPOSE_LABELS.PROJECT]: project,
    [COMPOSE_LABELS.SERVICE]: "postgres",
    [COMPOSE_LABELS.CONTAINER_NUMBER]: "1",
    [COMPOSE_LABELS.ONEOFF]: "False",
    [COMPOSE_LABELS.VERSION]: "2.39.1",
  });
}

/** 64 文字の hex ID をダミー生成する */
function dummyId(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

// === バリデーション関数のテスト ===

describe("validateRequiredLabels", () => {
  it("全ての required labels が存在すれば成功する", () => {
    // エラーを投げなければ成功
    expect(() => validateRequiredLabels(managedLabels())).not.toThrow();
  });

  it("required labels が不足している場合に HostResourceAdapterError を投げる", () => {
    // LEASE_ID を除外したラベルを作成
    const labels = managedLabels();
    delete labels[HACHI_LABELS.LEASE_ID];

    expect(() => validateRequiredLabels(labels)).toThrow(HostResourceAdapterError);
    try {
      validateRequiredLabels(labels);
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("missing_labels");
    }
  });

  it("managed が true でない場合に拒否する", () => {
    const labels = managedLabels({ [HACHI_LABELS.MANAGED]: "false" });

    expect(() => validateRequiredLabels(labels)).toThrow(HostResourceAdapterError);
    try {
      validateRequiredLabels(labels);
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("label_mismatch");
    }
  });
});

describe("verifyLabelsMatch", () => {
  it("完全一致で matched=true を返す", () => {
    const labels = managedLabels();
    const result = verifyLabelsMatch(labels, labels);

    expect(result.matched).toBe(true);
    expect(result.mismatches).toHaveLength(0);
  });

  it("値が異なるラベルを mismatches に報告する", () => {
    const actual = managedLabels();
    const expected = managedLabels({ [HACHI_LABELS.TASK_ID]: "t_other" });

    const result = verifyLabelsMatch(actual, expected);

    expect(result.matched).toBe(false);
    expect(result.mismatches).toContain(HACHI_LABELS.TASK_ID);
  });

  it("actual に存在しないラベルを不一致とする", () => {
    const actual: Record<string, string> = {};
    const expected = managedLabels();

    const result = verifyLabelsMatch(actual, expected);

    expect(result.matched).toBe(false);
    // 全ての required keys が mismatches に含まれる
    for (const key of REQUIRED_HACHI_LABEL_KEYS) {
      expect(result.mismatches).toContain(key);
    }
  });
});

describe("validateFullDockerIdFormat", () => {
  it("64 文字 hex を受け入れる", () => {
    const validId = "a".repeat(64);
    expect(() => validateFullDockerIdFormat(validId)).not.toThrow();
  });

  it("短縮 ID を拒否する", () => {
    const shortId = "abc123def456";
    expect(() => validateFullDockerIdFormat(shortId)).toThrow(HostResourceAdapterError);
    try {
      validateFullDockerIdFormat(shortId);
    } catch (e) {
      expect((e as HostResourceAdapterError).code).toBe("invalid_id");
    }
  });

  it("名前文字列を拒否する", () => {
    const name = "my-container-name";
    expect(() => validateFullDockerIdFormat(name)).toThrow(HostResourceAdapterError);
    try {
      validateFullDockerIdFormat(name);
    } catch (e) {
      expect((e as HostResourceAdapterError).code).toBe("invalid_id");
    }
  });
});

describe("validateExpectedLabelsForRemoval", () => {
  it("空の expectedLabels を拒否する", () => {
    expect(() => validateExpectedLabelsForRemoval({})).toThrow(HostResourceAdapterError);
    try {
      validateExpectedLabelsForRemoval({});
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("missing_labels");
    }
  });

  it("managed=true のみの部分ラベルを拒否する", () => {
    const partial = { [HACHI_LABELS.MANAGED]: "true" };
    expect(() => validateExpectedLabelsForRemoval(partial)).toThrow(HostResourceAdapterError);
    try {
      validateExpectedLabelsForRemoval(partial);
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("missing_labels");
    }
  });

  it("required labels 全てあるが lease-id が空の場合を拒否する", () => {
    const labels = managedLabels({ [HACHI_LABELS.LEASE_ID]: "" });
    expect(() => validateExpectedLabelsForRemoval(labels)).toThrow(HostResourceAdapterError);
    try {
      validateExpectedLabelsForRemoval(labels);
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("missing_labels");
    }
  });

  it("required labels 全てあるが task-id が空の場合を拒否する", () => {
    const labels = managedLabels({ [HACHI_LABELS.TASK_ID]: "" });
    expect(() => validateExpectedLabelsForRemoval(labels)).toThrow(HostResourceAdapterError);
    try {
      validateExpectedLabelsForRemoval(labels);
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("missing_labels");
    }
  });

  it("required labels 全てあるが bundle-kind が空の場合を拒否する", () => {
    const labels = managedLabels({ [HACHI_LABELS.BUNDLE_KIND]: "" });
    expect(() => validateExpectedLabelsForRemoval(labels)).toThrow(HostResourceAdapterError);
    try {
      validateExpectedLabelsForRemoval(labels);
    } catch (e) {
      expect(e).toBeInstanceOf(HostResourceAdapterError);
      expect((e as HostResourceAdapterError).code).toBe("missing_labels");
    }
  });

  it("完全な managed labels は受け入れる", () => {
    expect(() => validateExpectedLabelsForRemoval(managedLabels())).not.toThrow();
  });

  it("Compose project だけの expectedLabels を不十分な provenance として拒否する", () => {
    const labels = managedLabels({ [COMPOSE_LABELS.PROJECT]: "hachi_lease001" });
    expect(() => validateExpectedLabelsForRemoval(labels, "container"))
      .toThrow(HostResourceAdapterError);
  });

  it("container 用 Compose labels を network 用 expectedLabels として拒否する", () => {
    expect(() => validateExpectedLabelsForRemoval(composeContainerLabels(), "network"))
      .toThrow(HostResourceAdapterError);
  });
});

// === FakeHostResourceAdapter のテスト ===

describe("FakeHostResourceAdapter", () => {
  const SCOPE = "default";

  describe("provisionContainer", () => {
    it("required labels 付きで container を provision し、完全 ID と port mapping を返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      const result = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      // nativeId は 64 文字 hex
      expect(result.nativeId).toMatch(/^[\da-f]{64}$/);

      // portMappings の検証
      expect(result.portMappings).toHaveLength(1);
      expect(result.portMappings[0]!.hostIp).toBe("127.0.0.1");
      expect(result.portMappings[0]!.hostPort).toBeGreaterThan(0);
      expect(result.portMappings[0]!.hostPort).toBeLessThanOrEqual(65535);
      expect(result.portMappings[0]!.containerPort).toBe(5432);

      // labels が入力と一致する
      for (const [key, value] of Object.entries(labels)) {
        expect(result.labels[key]).toBe(value);
      }
    });

    it("required labels が不足する provision を拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
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
    });

    it("healthCheck 設定ありで healthy=true を返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const result = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels: managedLabels(),
        exposePorts: [5432],
        healthCheck: {
          command: ["pg_isready"],
          intervalMs: 1000,
          timeoutMs: 5000,
          retries: 3,
        },
      });

      expect(result.healthy).toBe(true);
    });

    it("healthCheck 未設定で healthy=true を返す（null は内部、外部は true）", async () => {
      const adapter = new FakeHostResourceAdapter();
      const result = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels: managedLabels(),
        exposePorts: [5432],
        // healthCheck 未設定
      });

      // provision 結果は外部向けに true を返す
      expect(result.healthy).toBe(true);

      // 内部的には null で保持されている（inspect で確認）
      const inspection = await adapter.inspectContainer(result.nativeId, SCOPE);
      expect(inspection).not.toBeNull();
      expect(inspection!.healthy).toBeNull();
    });

    it("複数ポートの provision を単一 mapping 契約違反として拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels: managedLabels(),
        exposePorts: [5432, 8080, 9090],
      })).rejects.toMatchObject({ code: "invalid_port" });
    });
  });

  describe("provisionNetwork", () => {
    it("required labels 付きで network を provision し、完全 ID を返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      const result = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "hachi-test-net",
        labels,
      });

      // nativeId は 64 文字 hex
      expect(result.nativeId).toMatch(/^[\da-f]{64}$/);

      // labels が入力と一致する
      for (const [key, value] of Object.entries(labels)) {
        expect(result.labels[key]).toBe(value);
      }
    });

    it("required labels が不足する provision を拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      delete labels[HACHI_LABELS.LEASE_ID];

      await expect(
        adapter.provisionNetwork({
          scopeKey: SCOPE,
          name: "hachi-test-net",
          labels,
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });
  });

  describe("inspectContainer", () => {
    it("provision 済み container を inspect できる", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      const inspection = await adapter.inspectContainer(provisioned.nativeId, SCOPE);

      expect(inspection).not.toBeNull();
      expect(inspection!.nativeId).toBe(provisioned.nativeId);
      expect(inspection!.scopeKey).toBe(SCOPE);
      expect(inspection!.running).toBe(true);
      expect(inspection!.portMappings).toHaveLength(1);
    });

    it("存在しない container は null を返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const result = await adapter.inspectContainer(dummyId(999), SCOPE);
      expect(result).toBeNull();
    });

    it("scopeKey が異なる inspect を side effect 前に拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels: managedLabels(),
        exposePorts: [5432],
      });

      // 異なる scopeKey で inspect
      await expect(
        adapter.inspectContainer(provisioned.nativeId, "other-scope"),
      ).rejects.toMatchObject({ code: "scope_mismatch" });
    });

    it("返却値の clone が fake inventory を改変しない", async () => {
      const adapter = new FakeHostResourceAdapter();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels: managedLabels(),
        exposePorts: [5432],
      });

      // 返却値を改変する
      const inspection1 = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(inspection1).not.toBeNull();
      (inspection1!.labels as Record<string, string>)["tampered"] = "yes";
      (inspection1!.portMappings[0] as { hostPort: number }).hostPort = 99999;

      // 再度 inspect して改変が反映されていないことを確認
      const inspection2 = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(inspection2).not.toBeNull();
      expect(inspection2!.labels["tampered"]).toBeUndefined();
      expect(inspection2!.portMappings[0]!.hostPort).not.toBe(99999);
    });
  });

  describe("inspectNetwork", () => {
    it("provision 済み network を inspect できる", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const provisioned = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });

      const inspection = await adapter.inspectNetwork(provisioned.nativeId, SCOPE);

      expect(inspection).not.toBeNull();
      expect(inspection!.nativeId).toBe(provisioned.nativeId);
      expect(inspection!.scopeKey).toBe(SCOPE);
      expect(inspection!.isBuiltInBridge).toBe(false);
    });

    it("接続中 container を connectedContainerIds に含める", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      // network を provision
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });

      // container を provision し network に接続
      const container = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        networkId: net.nativeId,
      });

      // network の inspect で connectedContainerIds に container が含まれる
      const inspection = await adapter.inspectNetwork(net.nativeId, SCOPE);
      expect(inspection).not.toBeNull();
      expect(inspection!.connectedContainerIds).toContain(container.nativeId);
    });

    it("built-in bridge は isBuiltInBridge=true で返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      adapter.addBuiltInBridge(SCOPE);

      // built-in bridge を検索するため、全 network をチェック（adapter は listing を持たないので addBuiltInBridge の返値を利用）
      const bridgeId = dummyId(0); // addBuiltInBridge にカスタム ID を渡す
      const adapter2 = new FakeHostResourceAdapter();
      adapter2.addBuiltInBridge(SCOPE, bridgeId);

      const inspection = await adapter2.inspectNetwork(bridgeId, SCOPE);
      expect(inspection).not.toBeNull();
      expect(inspection!.isBuiltInBridge).toBe(true);
    });
  });

  describe("removeContainer", () => {
    it("label 一致で container を正常に削除する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      const result = await adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-001",
      });

      expect(result.status).toBe("removed");
      expect(result.nativeId).toBe(provisioned.nativeId);

      // removeHistory に記録されている
      expect(adapter.removeHistory).toHaveLength(1);
      expect(adapter.removeHistory[0]!.kind).toBe("container");
      expect(adapter.removeHistory[0]!.nativeId).toBe(provisioned.nativeId);

      // inspect で null を返す（削除済み）
      const after = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(after).toBeNull();
    });

    it("存在しない container は already_absent を返す（冪等回復）", async () => {
      const adapter = new FakeHostResourceAdapter();

      const result = await adapter.removeContainer({
        nativeId: dummyId(404),
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-absent",
      });

      expect(result.status).toBe("already_absent");
    });

    it("label 不一致で fail-closed 拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      // 異なる task_id を期待して削除を試みる
      const wrongLabels = managedLabels({ [HACHI_LABELS.TASK_ID]: "t_wrong" });
      const result = await adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: SCOPE,
        expectedLabels: wrongLabels,
        executionNonce: "nonce-mismatch",
      });

      expect(result.status).toBe("label_mismatch");

      // container は削除されていない
      const inspection = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(inspection).not.toBeNull();
    });

    it("managed でない container の削除を拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const containerLabels = managedLabels({ [HACHI_LABELS.MANAGED]: "false" });
      const nativeId = dummyId(1);

      // managed=false の container を事前登録
      adapter.addContainer({
        nativeId,
        scopeKey: SCOPE,
        labels: containerLabels,
      });

      // expectedLabels は managed=true の完全ラベル（呼び出し側は managed を期待する）
      const result = await adapter.removeContainer({
        nativeId,
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-unmanaged",
      });

      // 実際の container の managed が false なので label_mismatch で拒否される
      expect(result.status).toBe("label_mismatch");
    });

    it("foreign/shared network attachment drift を fake でも削除前に拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const containerId = dummyId(405);
      const foreignNetworkId = dummyId(406);
      const labels = managedLabels();
      adapter.addNetwork({
        nativeId: foreignNetworkId,
        scopeKey: SCOPE,
        name: "shared-network",
        labels: {},
      });
      adapter.addContainer({
        nativeId: containerId,
        scopeKey: SCOPE,
        labels,
        networkIds: [foreignNetworkId],
      });

      const result = await adapter.removeContainer({
        nativeId: containerId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-foreign-attachment",
      });

      expect(result.status).toBe("label_mismatch");
      expect(result.failureDetail).toContain("attachment");
      expect(adapter.removeHistory).toHaveLength(0);
      expect(await adapter.inspectContainer(containerId, SCOPE)).not.toBeNull();
    });
  });

  describe("removeNetwork", () => {
    it("label 一致かつ接続 container なしで network を正常に削除する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });

      const result = await adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-net-001",
        expectedAbsentContainerIds: [],
      });

      expect(result.status).toBe("removed");

      // inspect で null を返す
      const after = await adapter.inspectNetwork(net.nativeId, SCOPE);
      expect(after).toBeNull();
    });

    it("built-in bridge の削除を拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const bridgeId = dummyId(77);
      adapter.addBuiltInBridge(SCOPE, bridgeId);

      const result = await adapter.removeNetwork({
        nativeId: bridgeId,
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-bridge",
        expectedAbsentContainerIds: [],
      });

      expect(result.status).toBe("bridge_protected");
    });

    it("存在しない network は already_absent を返す", async () => {
      const adapter = new FakeHostResourceAdapter();

      const result = await adapter.removeNetwork({
        nativeId: dummyId(404),
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-net-absent",
        expectedAbsentContainerIds: [],
      });

      expect(result.status).toBe("already_absent");
    });

    it("label 不一致で fail-closed 拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });

      const wrongLabels = managedLabels({ [HACHI_LABELS.BOARD]: "wrong-board" });
      const result = await adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: SCOPE,
        expectedLabels: wrongLabels,
        executionNonce: "nonce-net-mismatch",
        expectedAbsentContainerIds: [],
      });

      expect(result.status).toBe("label_mismatch");

      // network は削除されていない
      const inspection = await adapter.inspectNetwork(net.nativeId, SCOPE);
      expect(inspection).not.toBeNull();
    });

    it("expectedAbsentContainerIds がまだ存在する場合に containers_remain を返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      // container と network を provision（container を network に接続）
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });
      const container = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        networkId: net.nativeId,
      });

      // container を削除せずに network 削除を試みる
      const result = await adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-net-remain",
        expectedAbsentContainerIds: [container.nativeId],
      });

      expect(result.status).toBe("containers_remain");
    });

    it("接続中 container が残っている network の削除を拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      // network を provision
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });

      // container を provision し network に接続
      await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        networkId: net.nativeId,
      });

      // expectedAbsentContainerIds を空にしても、接続中 container があるため拒否
      const result = await adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-net-connected",
        expectedAbsentContainerIds: [],
      });

      expect(result.status).toBe("containers_remain");
    });
  });

  describe("container → network 安全順序", () => {
    it("container 削除後に network 削除が成功する正しい順序", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      // network → container の順で provision
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });
      const container = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        networkId: net.nativeId,
      });

      // 正しい順序: container を先に削除
      const containerResult = await adapter.removeContainer({
        nativeId: container.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-c-first",
      });
      expect(containerResult.status).toBe("removed");

      // その後 network を削除
      const networkResult = await adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-n-second",
        expectedAbsentContainerIds: [container.nativeId],
      });
      expect(networkResult.status).toBe("removed");
    });

    it("container 削除前に network 削除を試みると拒否される", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();

      // network → container の順で provision
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });
      const container = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        networkId: net.nativeId,
      });

      // 誤った順序: network を先に削除しようとする
      const networkResult = await adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-n-first",
        expectedAbsentContainerIds: [container.nativeId],
      });
      expect(networkResult.status).toBe("containers_remain");
    });
  });

  describe("legacy resource 保護: 32 件存在、対象外 delete 0 件", () => {
    it("32 件の legacy resource が存在しても、managed target のみ削除し legacy への delete は 0 件", async () => {
      const adapter = new FakeHostResourceAdapter();

      // 16 件の legacy container を登録
      for (let i = 0; i < 16; i++) {
        adapter.addLegacyContainer(dummyId(i + 100), SCOPE, `legacy-project-${String(i)}`);
      }

      // 16 件の legacy network を登録
      for (let i = 0; i < 16; i++) {
        adapter.addLegacyNetwork(dummyId(i + 200), SCOPE, `legacy-net-${String(i)}`);
      }

      // legacy が 32 件存在することを確認
      expect(adapter.containerCount).toBe(16);
      expect(adapter.networkCount).toBe(16);

      // managed container を 1 件 provision
      const labels = managedLabels();
      const managed = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      // managed container を削除
      const result = await adapter.removeContainer({
        nativeId: managed.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-managed-only",
      });
      expect(result.status).toBe("removed");

      // removeHistory には managed container の 1 件のみ
      expect(adapter.removeHistory).toHaveLength(1);
      expect(adapter.removeHistory[0]!.nativeId).toBe(managed.nativeId);

      // legacy container 16 件は全て残存
      for (let i = 0; i < 16; i++) {
        const inspection = await adapter.inspectContainer(dummyId(i + 100), SCOPE);
        expect(inspection).not.toBeNull();
      }

      // legacy network 16 件は全て残存
      for (let i = 0; i < 16; i++) {
        const inspection = await adapter.inspectNetwork(dummyId(i + 200), SCOPE);
        expect(inspection).not.toBeNull();
      }
    });
  });

  describe("volume 非破壊", () => {
    it("HostResourceAdapter interface に volume 削除メソッドが存在しない", () => {
      const adapter = new FakeHostResourceAdapter();

      // removeVolume メソッドが存在しないことを型安全に確認
      expect("removeVolume" in adapter).toBe(false);
    });
  });

  // === 新規テスト: 短縮 ID / 名前 / 空文字の拒否 ===

  describe("短縮 ID / 名前 / 空文字の拒否", () => {
    it("inspectContainer に短縮 ID を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.inspectContainer("abc123def456", SCOPE),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("inspectContainer に名前文字列を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.inspectContainer("my-container-name", SCOPE),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("inspectContainer に空文字を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.inspectContainer("", SCOPE),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("inspectNetwork に短縮 ID を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.inspectNetwork("abc123def456", SCOPE),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("inspectNetwork に名前文字列を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.inspectNetwork("my-network-name", SCOPE),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("inspectNetwork に空文字を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.inspectNetwork("", SCOPE),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("removeContainer に短縮 ID を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.removeContainer({
          nativeId: "abc123def456",
          scopeKey: SCOPE,
          expectedLabels: managedLabels(),
          executionNonce: "nonce-short",
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("removeNetwork に短縮 ID を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.removeNetwork({
          nativeId: "abc123def456",
          scopeKey: SCOPE,
          expectedLabels: managedLabels(),
          executionNonce: "nonce-short-net",
          expectedAbsentContainerIds: [],
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });
  });

  // === 新規テスト: 空/部分 expectedLabels の拒否 ===

  describe("空/部分 expectedLabels の拒否", () => {
    it("removeContainer に空の expectedLabels を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.removeContainer({
          nativeId: dummyId(1),
          scopeKey: SCOPE,
          expectedLabels: {},
          executionNonce: "nonce-empty",
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("removeContainer に managed=true のみの expectedLabels を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.removeContainer({
          nativeId: dummyId(1),
          scopeKey: SCOPE,
          expectedLabels: { [HACHI_LABELS.MANAGED]: "true" },
          executionNonce: "nonce-partial",
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("removeNetwork に空の expectedLabels を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.removeNetwork({
          nativeId: dummyId(1),
          scopeKey: SCOPE,
          expectedLabels: {},
          executionNonce: "nonce-empty-net",
          expectedAbsentContainerIds: [],
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });

    it("removeNetwork に managed=true のみの expectedLabels を渡すと拒否", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(
        adapter.removeNetwork({
          nativeId: dummyId(1),
          scopeKey: SCOPE,
          expectedLabels: { [HACHI_LABELS.MANAGED]: "true" },
          executionNonce: "nonce-partial-net",
          expectedAbsentContainerIds: [],
        }),
      ).rejects.toThrow(HostResourceAdapterError);
    });
  });

  // === 新規テスト: scope/context 不一致 ===

  describe("scope/context 不一致", () => {
    it("異なる scopeKey で removeContainer を試みると拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      // adapter に固定した scope と異なるため command 前に拒否される
      await expect(adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: "other-scope",
        expectedLabels: labels,
        executionNonce: "nonce-wrong-scope",
      })).rejects.toMatchObject({ code: "scope_mismatch" });
    });

    it("異なる scopeKey で removeNetwork を試みると拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const net = await adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "test-net",
        labels,
      });

      // adapter に固定した scope と異なるため command 前に拒否される
      await expect(adapter.removeNetwork({
        nativeId: net.nativeId,
        scopeKey: "other-scope",
        expectedLabels: labels,
        executionNonce: "nonce-wrong-scope-net",
        expectedAbsentContainerIds: [],
      })).rejects.toMatchObject({ code: "scope_mismatch" });
    });
  });

  // === 新規テスト: Compose/Hachi label 不一致 ===

  describe("Compose/Hachi label 不一致", () => {
    it("実 container のラベルと expectedLabels の board が異なる場合 label_mismatch", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels({ [HACHI_LABELS.BOARD]: "production" });
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      // 異なる board を期待して削除を試みる
      const wrongLabels = managedLabels({ [HACHI_LABELS.BOARD]: "staging" });
      const result = await adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: SCOPE,
        expectedLabels: wrongLabels,
        executionNonce: "nonce-board-mismatch",
      });

      expect(result.status).toBe("label_mismatch");

      // container は削除されていない
      const inspection = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(inspection).not.toBeNull();
    });

    it("実 container のラベルと expectedLabels の lease-id が異なる場合 label_mismatch", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels({ [HACHI_LABELS.LEASE_ID]: "lease-aaa" });
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });

      // 異なる lease-id を期待して削除を試みる
      const wrongLabels = managedLabels({ [HACHI_LABELS.LEASE_ID]: "lease-bbb" });
      const result = await adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: SCOPE,
        expectedLabels: wrongLabels,
        executionNonce: "nonce-lease-mismatch",
      });

      expect(result.status).toBe("label_mismatch");

      // container は削除されていない
      const inspection = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(inspection).not.toBeNull();
    });

    it("Compose object で expected project label を省略すると削除を拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = composeContainerLabels();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        composeProject: "hachi_lease001",
      });

      const result = await adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-compose-missing",
      });

      expect(result.status).toBe("label_mismatch");
      expect(adapter.removeHistory).toHaveLength(0);
    });

    it("Compose service/oneoff の不一致を fake でも削除前に拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = composeContainerLabels();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
        composeProject: "hachi_lease001",
      });

      const wrongLabels = {
        ...composeContainerLabels(),
        [COMPOSE_LABELS.SERVICE]: "other-service",
        [COMPOSE_LABELS.ONEOFF]: "True",
      };
      const result = await adapter.removeContainer({
        nativeId: provisioned.nativeId,
        scopeKey: SCOPE,
        expectedLabels: wrongLabels,
        executionNonce: "nonce-compose-service-oneoff-mismatch",
      });

      expect(result.status).toBe("label_mismatch");
      expect(adapter.removeHistory).toHaveLength(0);
    });
  });

  describe("provision safety boundary", () => {
    it.each<readonly [number[]]>([[[]], [[0]], [[65536]], [[5432, 8080]]])(
      "invalid exposePorts %j を拒否する",
      async (exposePorts) => {
        const adapter = new FakeHostResourceAdapter();
        await expect(adapter.provisionContainer({
          scopeKey: SCOPE,
          image: "postgres:16",
          labels: managedLabels(),
          exposePorts,
        })).rejects.toMatchObject({ code: "invalid_port" });
        expect(adapter.containerCount).toBe(0);
      },
    );

    it("built-in bridge を provision/member 化しない", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "bridge",
        labels: managedLabels(),
      })).rejects.toMatchObject({ code: "bridge_protected" });
      expect(adapter.networkCount).toBe(0);
    });
  });

  describe("review regression boundaries", () => {
    it("networkId 未指定 provision は built-in bridge の完全 ID attachment を返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const provisioned = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels: managedLabels(),
        exposePorts: [5432],
      });

      const container = await adapter.inspectContainer(provisioned.nativeId, SCOPE);
      expect(container?.networkIds).toHaveLength(1);
      const bridgeId = container?.networkIds[0];
      expect(bridgeId).toMatch(/^[\da-f]{64}$/);
      expect(await adapter.inspectNetwork(bridgeId!, SCOPE)).toMatchObject({
        isBuiltInBridge: true,
        connectedContainerIds: [provisioned.nativeId],
      });
      expect(adapter.networkCount).toBe(0);
    });

    it.each([
      ["wildcard", { containerPort: 5432, hostIp: "0.0.0.0", hostPort: 49152 }, "wildcard_bind"],
      ["invalid host port", { containerPort: 5432, hostIp: "127.0.0.1", hostPort: 0 }, "invalid_port"],
      ["invalid container port", { containerPort: 0, hostIp: "127.0.0.1", hostPort: 49152 }, "invalid_port"],
    ] as const)("fake public inspect は %s mapping を拒否する", async (_name, mapping, code) => {
      const adapter = new FakeHostResourceAdapter();
      const id = dummyId(500);
      adapter.addContainer({
        nativeId: id,
        scopeKey: SCOPE,
        labels: managedLabels(),
        portMappings: [mapping],
      });

      await expect(adapter.inspectContainer(id, SCOPE)).rejects.toMatchObject({ code });
    });

    it("任意 driver network の provision/remove を usage unknown として拒否する", async () => {
      const adapter = new FakeHostResourceAdapter();
      await expect(adapter.provisionNetwork({
        scopeKey: SCOPE,
        name: "overlay-net",
        labels: managedLabels(),
        driver: "overlay",
      })).rejects.toMatchObject({ code: "inspect_failed" });

      const id = dummyId(501);
      adapter.addNetwork({
        nativeId: id,
        scopeKey: SCOPE,
        name: "plugin-net",
        labels: managedLabels(),
        driver: "third-party-plugin",
      });
      await expect(adapter.removeNetwork({
        nativeId: id,
        scopeKey: SCOPE,
        expectedLabels: managedLabels(),
        executionNonce: "nonce-plugin-net",
        expectedAbsentContainerIds: [],
      })).rejects.toMatchObject({ code: "inspect_failed" });
      expect(adapter.removeHistory).toHaveLength(0);
    });

    it("remove 成功は同じ exact ID の absent 再確認後だけ返す", async () => {
      const adapter = new FakeHostResourceAdapter();
      const labels = managedLabels();
      const container = await adapter.provisionContainer({
        scopeKey: SCOPE,
        image: "postgres:16",
        labels,
        exposePorts: [5432],
      });
      expect((await adapter.removeContainer({
        nativeId: container.nativeId,
        scopeKey: SCOPE,
        expectedLabels: labels,
        executionNonce: "nonce-confirm-absent",
      })).status).toBe("removed");
      expect(await adapter.inspectContainer(container.nativeId, SCOPE)).toBeNull();
    });
  });
});
