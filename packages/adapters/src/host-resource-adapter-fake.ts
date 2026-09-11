import { randomBytes } from "node:crypto";

import type {
  ContainerInspection,
  HostResourceAdapter,
  HostResourceOperationOptions,
  NetworkInspection,
  PortMapping,
  ProvisionContainerParams,
  ProvisionContainerResult,
  ProvisionNetworkParams,
  ProvisionNetworkResult,
  RemoveContainerParams,
  RemoveNetworkParams,
  RemoveResult,
} from "./host-resource-adapter.js";
import {
  COMPOSE_LABELS,
  HACHI_LABELS,
  HostResourceAdapterError,
  REQUIRED_HACHI_LABEL_KEYS,
  validateComposeProvenance,
  validateExpectedLabelsForRemoval,
  validateFullDockerIdFormat,
  validatePortMapping,
  validateRequiredLabels,
  verifyRemovalLabelsMatch,
} from "./host-resource-adapter.js";

// === 内部状態 ===

interface FakeContainer {
  nativeId: string;
  scopeKey: string;
  labels: Record<string, string>;
  portMappings: PortMapping[];
  networkIds: string[];
  running: boolean;
  healthy: boolean | null;
  createdAt: number;
}

interface FakeNetwork {
  nativeId: string;
  scopeKey: string;
  name: string;
  labels: Record<string, string>;
  driver: string;
  isBuiltInBridge: boolean;
  createdAt: number;
}

function generateFakeId(): string {
  return randomBytes(32).toString("hex");
}

function cloneLabels(labels: Readonly<Record<string, string>>): Record<string, string> {
  return { ...labels };
}

function clonePortMappings(mappings: readonly PortMapping[]): PortMapping[] {
  return mappings.map((m) => ({ ...m }));
}

const DEFAULT_BUILT_IN_BRIDGE_ID = "f".repeat(64);

function validateFakePortMappings(mappings: readonly PortMapping[]): void {
  for (const mapping of mappings) {
    if (
      !Number.isInteger(mapping.containerPort)
      || mapping.containerPort <= 0
      || mapping.containerPort > 65535
    ) {
      throw new HostResourceAdapterError(
        `無効な container port: ${String(mapping.containerPort)}`,
        "invalid_port",
      );
    }
    validatePortMapping(mapping);
  }
}

function validateManagedNetworkDriver(driver: string): void {
  if (driver !== "bridge") {
    throw new HostResourceAdapterError(
      `managed network は usage を完全に検証できる bridge driver のみ許可されます: ${driver}`,
      "inspect_failed",
    );
  }
}

const ATTACHMENT_OWNER_LABEL_KEYS: readonly string[] = REQUIRED_HACHI_LABEL_KEYS.filter(
  (key) => key !== HACHI_LABELS.OBJECT_FENCE,
);

/**
 * unit/integration test 用の HostResourceAdapter fake。
 * 外部 Docker API・process・network へ一切触れない。
 * exact ID + label 一致のみ操作を許可し、不一致は fail-closed で拒否する。
 */
export class FakeHostResourceAdapter implements HostResourceAdapter {
  private readonly containers = new Map<string, FakeContainer>();
  private readonly networks = new Map<string, FakeNetwork>();
  private nextPort = 49152;
  private readonly removedLog: Array<{ kind: "container" | "network"; nativeId: string; nonce: string }> = [];
  private clock: () => number;
  private readonly scopeKey: string;
  private builtInBridgeId = DEFAULT_BUILT_IN_BRIDGE_ID;

  constructor(options?: { clock?: () => number; scopeKey?: string }) {
    this.clock = options?.clock ?? (() => Date.now());
    this.scopeKey = options?.scopeKey ?? "default";
    if (this.scopeKey.trim() === "") {
      throw new HostResourceAdapterError("scopeKey は空にできません", "scope_mismatch");
    }
    this.addBuiltInBridge(this.scopeKey, this.builtInBridgeId);
  }

  private validateScope(scopeKey: string): void {
    if (scopeKey !== this.scopeKey) {
      throw new HostResourceAdapterError(
        `Docker scope が fake adapter と一致しません: expected=${this.scopeKey}`,
        "scope_mismatch",
      );
    }
  }

  // === テストヘルパー ===

  /** remove 操作の履歴。テスト assertion 用。 */
  get removeHistory(): ReadonlyArray<{ kind: "container" | "network"; nativeId: string; nonce: string }> {
    return [...this.removedLog];
  }

  /** 現在の container 数 */
  get containerCount(): number {
    return this.containers.size;
  }

  /** 現在の network 数 */
  get networkCount(): number {
    return [...this.networks.values()].filter((network) => !network.isBuiltInBridge).length;
  }

  /** テスト用: 任意の container を事前登録する */
  addContainer(entry: {
    nativeId: string;
    scopeKey: string;
    labels: Record<string, string>;
    portMappings?: PortMapping[];
    networkIds?: string[];
    running?: boolean;
    healthy?: boolean | null;
  }): void {
    this.containers.set(entry.nativeId, {
      nativeId: entry.nativeId,
      scopeKey: entry.scopeKey,
      labels: cloneLabels(entry.labels),
      portMappings: entry.portMappings ? clonePortMappings(entry.portMappings) : [],
      networkIds: entry.networkIds ? [...entry.networkIds] : [],
      running: entry.running ?? true,
      healthy: entry.healthy ?? null,
      createdAt: this.clock(),
    });
  }

  /** テスト用: 任意の network を事前登録する */
  addNetwork(entry: {
    nativeId: string;
    scopeKey: string;
    name: string;
    labels: Record<string, string>;
    driver?: string;
    isBuiltInBridge?: boolean;
  }): void {
    this.networks.set(entry.nativeId, {
      nativeId: entry.nativeId,
      scopeKey: entry.scopeKey,
      name: entry.name,
      labels: cloneLabels(entry.labels),
      driver: entry.driver ?? "bridge",
      isBuiltInBridge: entry.isBuiltInBridge ?? false,
      createdAt: this.clock(),
    });
  }

  /** テスト用: built-in bridge network を登録する */
  addBuiltInBridge(scopeKey: string, nativeId?: string): void {
    const id = nativeId ?? generateFakeId();
    validateFullDockerIdFormat(id);
    this.networks.delete(this.builtInBridgeId);
    this.builtInBridgeId = id;
    this.networks.set(id, {
      nativeId: id,
      scopeKey,
      name: "bridge",
      labels: {},
      driver: "bridge",
      isBuiltInBridge: true,
      createdAt: this.clock(),
    });
  }

  /** テスト用: legacy（Hachi ラベルなし）container を登録する */
  addLegacyContainer(nativeId: string, scopeKey: string, name?: string): void {
    this.containers.set(nativeId, {
      nativeId,
      scopeKey,
      labels: name !== undefined ? { "com.docker.compose.project": name } : {},
      portMappings: [],
      networkIds: [],
      running: true,
      healthy: null,
      createdAt: this.clock(),
    });
  }

  /** テスト用: legacy（Hachi ラベルなし）network を登録する */
  addLegacyNetwork(nativeId: string, scopeKey: string, name?: string): void {
    this.networks.set(nativeId, {
      nativeId,
      scopeKey,
      name: name ?? "legacy-net",
      labels: name !== undefined ? { "com.docker.compose.project": name } : {},
      driver: "bridge",
      isBuiltInBridge: false,
      createdAt: this.clock(),
    });
  }

  // === HostResourceAdapter implementation ===

  async provisionContainer(params: ProvisionContainerParams): Promise<ProvisionContainerResult> {
    this.validateScope(params.scopeKey);
    validateRequiredLabels(params.labels);
    if (
      params.exposePorts.length !== 1
      || !Number.isInteger(params.exposePorts[0])
      || (params.exposePorts[0] ?? 0) <= 0
      || (params.exposePorts[0] ?? 0) > 65535
    ) {
      throw new HostResourceAdapterError(
        "container provision は 1 件の有効な container port mapping が必要です",
        "invalid_port",
      );
    }
    validateComposeProvenance(params.labels, params.composeProject, "container");
    if (params.networkId !== undefined) {
      validateFullDockerIdFormat(params.networkId);
      const network = this.networks.get(params.networkId);
      if (network === undefined || network.scopeKey !== this.scopeKey) {
        throw new HostResourceAdapterError(
          "要求した exact network ID の attachment を検証できません",
          "inspect_failed",
        );
      }
    }

    const nativeId = generateFakeId();
    const portMappings: PortMapping[] = params.exposePorts.map((containerPort) => ({
      containerPort,
      hostIp: "127.0.0.1",
      hostPort: this.nextPort++,
    }));

    const container: FakeContainer = {
      nativeId,
      scopeKey: params.scopeKey,
      labels: cloneLabels(params.labels),
      portMappings: clonePortMappings(portMappings),
      networkIds: [params.networkId ?? this.builtInBridgeId],
      running: true,
      healthy: params.healthCheck !== undefined ? true : null,
      createdAt: this.clock(),
    };

    this.containers.set(nativeId, container);

    // network の connectedContainerIds は inspect 時に containers map の networkIds から動的に導出する。
    // ここでは container 側の networkIds だけ設定すれば十分。

    return {
      nativeId,
      portMappings: clonePortMappings(portMappings),
      labels: cloneLabels(params.labels),
      healthy: container.healthy ?? true,
    };
  }

  async provisionNetwork(params: ProvisionNetworkParams): Promise<ProvisionNetworkResult> {
    this.validateScope(params.scopeKey);
    validateRequiredLabels(params.labels);
    validateComposeProvenance(params.labels, params.composeProject, "network");
    if (params.name.trim() === "" || params.name === "bridge") {
      throw new HostResourceAdapterError(
        "空名または built-in bridge network は provision できません",
        "bridge_protected",
      );
    }

    const driver = params.driver ?? "bridge";
    validateManagedNetworkDriver(driver);
    const nativeId = generateFakeId();
    const network: FakeNetwork = {
      nativeId,
      scopeKey: params.scopeKey,
      name: params.name,
      labels: cloneLabels(params.labels),
      driver,
      isBuiltInBridge: false,
      createdAt: this.clock(),
    };

    this.networks.set(nativeId, network);

    return {
      nativeId,
      labels: cloneLabels(params.labels),
    };
  }

  async inspectContainer(
    nativeId: string,
    scopeKey: string,
    options?: HostResourceOperationOptions,
  ): Promise<ContainerInspection | null> {
    options?.signal?.throwIfAborted();
    // 完全 ID 検証（64 文字 hex）
    validateFullDockerIdFormat(nativeId);
    this.validateScope(scopeKey);
    const container = this.containers.get(nativeId);
    if (container === undefined || container.scopeKey !== this.scopeKey) {
      return null;
    }
    validateFakePortMappings(container.portMappings);
    for (const networkId of container.networkIds) {
      validateFullDockerIdFormat(networkId);
    }
    return {
      nativeId: container.nativeId,
      scopeKey: container.scopeKey,
      running: container.running,
      healthy: container.healthy,
      labels: cloneLabels(container.labels),
      portMappings: clonePortMappings(container.portMappings),
      networkIds: [...container.networkIds],
      observedAt: this.clock(),
    };
  }

  async inspectNetwork(
    nativeId: string,
    scopeKey: string,
    options?: HostResourceOperationOptions,
  ): Promise<NetworkInspection | null> {
    options?.signal?.throwIfAborted();
    // 完全 ID 検証（64 文字 hex）
    validateFullDockerIdFormat(nativeId);
    this.validateScope(scopeKey);
    const network = this.networks.get(nativeId);
    if (network === undefined || network.scopeKey !== this.scopeKey) {
      return null;
    }

    // 接続中 container を動的に導出する
    const connectedContainerIds: string[] = [];
    for (const container of this.containers.values()) {
      if (container.networkIds.includes(nativeId)) {
        connectedContainerIds.push(container.nativeId);
      }
    }

    return {
      nativeId: network.nativeId,
      scopeKey: network.scopeKey,
      labels: cloneLabels(network.labels),
      connectedContainerIds,
      isBuiltInBridge: network.isBuiltInBridge,
      driver: network.driver,
      observedAt: this.clock(),
    };
  }

  async removeContainer(
    params: RemoveContainerParams,
    options?: HostResourceOperationOptions,
  ): Promise<RemoveResult> {
    options?.signal?.throwIfAborted();
    // 完全 ID 検証（64 文字 hex）
    validateFullDockerIdFormat(params.nativeId);
    this.validateScope(params.scopeKey);
    if (params.executionNonce.trim() === "") {
      throw new HostResourceAdapterError(
        "remove には空でない executionNonce が必要です",
        "invalid_argument",
      );
    }
    // expectedLabels の required Hachi labels conjunction 検証
    validateExpectedLabelsForRemoval(params.expectedLabels, "container");

    // fresh inspect
    const inspection = await this.inspectContainer(params.nativeId, params.scopeKey, options);

    // 存在しない → 冪等回復
    if (inspection === null) {
      return { status: "already_absent", nativeId: params.nativeId };
    }

    // label 検証（fail-closed）
    const { matched, mismatches } = verifyRemovalLabelsMatch(
      inspection.labels,
      params.expectedLabels,
    );
    if (!matched) {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `ラベル不一致: ${mismatches.join(", ")}`,
      };
    }

    // managed 検証
    if (inspection.labels[HACHI_LABELS.MANAGED] !== "true") {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `${HACHI_LABELS.MANAGED} が "true" ではありません`,
      };
    }

    if (inspection.networkIds.length !== 1) {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `container の network attachment は 1 件である必要があります: ${String(inspection.networkIds.length)} 件`,
      };
    }
    const attachedNetworkId = inspection.networkIds[0];
    if (attachedNetworkId === undefined) {
      throw new HostResourceAdapterError(
        "container の network attachment ID が欠落しています",
        "inspect_failed",
      );
    }
    const attachedNetwork = await this.inspectNetwork(attachedNetworkId, params.scopeKey, options);
    if (attachedNetwork === null) {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: "container の attachment 先 network を fresh inspect できません",
      };
    }
    if (!attachedNetwork.isBuiltInBridge) {
      try {
        validateManagedNetworkDriver(attachedNetwork.driver);
        validateRequiredLabels(attachedNetwork.labels);
        const expectedOwnerLabels = Object.fromEntries(
          ATTACHMENT_OWNER_LABEL_KEYS.map((key) => [key, params.expectedLabels[key]]),
        ) as Record<string, string>;
        for (const [key, expectedValue] of Object.entries(expectedOwnerLabels)) {
          if (attachedNetwork.labels[key] !== expectedValue) {
            return {
              status: "label_mismatch",
              nativeId: params.nativeId,
              lastInspection: inspection,
              failureDetail: `attachment 先 network の owner/provenance 不一致: ${key}`,
            };
          }
        }
        const composeProject = params.expectedLabels[COMPOSE_LABELS.PROJECT];
        validateComposeProvenance(attachedNetwork.labels, composeProject, "network");
      } catch (error) {
        if (!(error instanceof HostResourceAdapterError)) throw error;
        return {
          status: "label_mismatch",
          nativeId: params.nativeId,
          lastInspection: inspection,
          failureDetail: `attachment 先 network の検証に失敗しました: ${error.message}`,
        };
      }
    }

    // 削除実行
    this.containers.delete(params.nativeId);
    this.removedLog.push({ kind: "container", nativeId: params.nativeId, nonce: params.executionNonce });

    if (await this.inspectContainer(params.nativeId, params.scopeKey, options) !== null) {
      throw new HostResourceAdapterError(
        "fake remove 後も同じ exact container ID が存在します",
        "inspect_failed",
      );
    }

    return {
      status: "removed",
      nativeId: params.nativeId,
      lastInspection: inspection,
    };
  }

  async removeNetwork(
    params: RemoveNetworkParams,
    options?: HostResourceOperationOptions,
  ): Promise<RemoveResult> {
    options?.signal?.throwIfAborted();
    // 完全 ID 検証（64 文字 hex）
    validateFullDockerIdFormat(params.nativeId);
    this.validateScope(params.scopeKey);
    if (params.executionNonce.trim() === "") {
      throw new HostResourceAdapterError(
        "remove には空でない executionNonce が必要です",
        "invalid_argument",
      );
    }
    // expectedLabels の required Hachi labels conjunction 検証
    validateExpectedLabelsForRemoval(params.expectedLabels, "network");
    // expectedAbsentContainerIds の完全 ID 検証
    for (const containerId of params.expectedAbsentContainerIds) {
      validateFullDockerIdFormat(containerId);
    }

    // fresh inspect
    const inspection = await this.inspectNetwork(params.nativeId, params.scopeKey, options);

    // 存在しない → 冪等回復
    if (inspection === null) {
      return { status: "already_absent", nativeId: params.nativeId };
    }

    // built-in bridge 保護
    if (inspection.isBuiltInBridge) {
      return {
        status: "bridge_protected",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: "built-in bridge network は削除できません",
      };
    }
    validateManagedNetworkDriver(inspection.driver);

    // label 検証（fail-closed）
    const { matched, mismatches } = verifyRemovalLabelsMatch(
      inspection.labels,
      params.expectedLabels,
    );
    if (!matched) {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `ラベル不一致: ${mismatches.join(", ")}`,
      };
    }

    // managed 検証
    if (inspection.labels[HACHI_LABELS.MANAGED] !== "true") {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `${HACHI_LABELS.MANAGED} が "true" ではありません`,
      };
    }

    // member container が消えたことを再検証する
    for (const containerId of params.expectedAbsentContainerIds) {
      const containerInspection = await this.inspectContainer(containerId, params.scopeKey, options);
      if (containerInspection !== null) {
        return {
          status: "containers_remain",
          nativeId: params.nativeId,
          lastInspection: inspection,
          failureDetail: `期待される absent container がまだ存在します: ${containerId.slice(0, 12)}`,
        };
      }
    }

    // 接続中 container がないことを検証する（fresh inspect を再取得）
    const freshInspection = await this.inspectNetwork(params.nativeId, params.scopeKey, options);
    if (freshInspection === null) {
      return { status: "already_absent", nativeId: params.nativeId };
    }
    if (freshInspection.isBuiltInBridge) {
      return {
        status: "bridge_protected",
        nativeId: params.nativeId,
        lastInspection: freshInspection,
        failureDetail: "built-in bridge network は削除できません",
      };
    }
    validateManagedNetworkDriver(freshInspection.driver);
    const freshLabels = verifyRemovalLabelsMatch(
      freshInspection.labels,
      params.expectedLabels,
    );
    if (!freshLabels.matched) {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: freshInspection,
        failureDetail: `fresh inspect のラベル不一致: ${freshLabels.mismatches.join(", ")}`,
      };
    }
    if (freshInspection.connectedContainerIds.length > 0) {
      return {
        status: "containers_remain",
        nativeId: params.nativeId,
        lastInspection: freshInspection,
        failureDetail: `ネットワークにまだ container が接続されています: ${freshInspection.connectedContainerIds.map((id) => id.slice(0, 12)).join(", ")}`,
      };
    }

    // 削除実行
    this.networks.delete(params.nativeId);
    this.removedLog.push({ kind: "network", nativeId: params.nativeId, nonce: params.executionNonce });

    if (await this.inspectNetwork(params.nativeId, params.scopeKey, options) !== null) {
      throw new HostResourceAdapterError(
        "fake remove 後も同じ exact network ID が存在します",
        "inspect_failed",
      );
    }

    return {
      status: "removed",
      nativeId: params.nativeId,
      lastInspection: inspection,
    };
  }
}
