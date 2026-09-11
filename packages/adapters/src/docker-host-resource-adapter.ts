import { isAbsolute } from "node:path";
import type {
  ContainerInspection,
  CreatedHostResource,
  HealthCheckConfig,
  HostResourceAdapter,
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
  validateRequiredLabels,
  verifyLabelsMatch,
  verifyRemovalLabelsMatch,
} from "./host-resource-adapter.js";

// === CommandRunner DI 境界 ===

/** コマンド実行結果 */
export interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** command 実行を呼び出し側の wall-clock budget に拘束する制御。 */
export interface CommandRunnerOptions {
  signal?: AbortSignal;
}

/** argv 配列ベースのコマンド実行インターフェース（シェル文字列禁止） */
export interface CommandRunner {
  run(argv: readonly string[], options?: CommandRunnerOptions): Promise<CommandRunnerResult>;
}

// === Docker inspect JSON の型定義（noUncheckedIndexedAccess 対応） ===

/** docker inspect の port binding 1 件 */
interface DockerPortBinding {
  HostIp?: string;
  HostPort?: string;
}

/** docker inspect の NetworkSettings.Ports エントリ */
type DockerPortsMap = Record<string, DockerPortBinding[] | null | undefined>;

/** docker inspect の State フィールド */
interface DockerInspectState {
  Running?: boolean;
  Health?: {
    Status?: string;
  };
}

/** docker inspect のネットワーク設定 */
interface DockerInspectNetworkSettings {
  Ports?: DockerPortsMap;
  Networks?: Record<string, { NetworkID?: string } | undefined>;
}

/** docker inspect --format '{{json .}}' の container JSON */
interface DockerContainerInspectJson {
  Id?: string;
  State?: DockerInspectState;
  Config?: {
    Labels?: Record<string, string>;
  };
  NetworkSettings?: DockerInspectNetworkSettings;
}

/** docker network inspect の JSON 配列要素 */
interface DockerNetworkInspectJson {
  Id?: string;
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string>;
  Containers?: Record<string, unknown>;
}

// === ヘルパー関数 ===

/** 64 文字 hex パターン */
const FULL_ID_PATTERN = /^[\da-f]{64}$/i;

/** stdout の先頭行から 64 文字 hex の Docker ID を抽出する */
function parseDockerIdFromStdout(stdout: string): string {
  const trimmed = stdout.trim();
  // 完全 ID が改行なしで返ってくるケースと、先頭行に含まれるケース
  const firstLine = trimmed.split("\n")[0];
  if (firstLine === undefined) {
    throw new HostResourceAdapterError(
      "docker コマンドの stdout が空です。ID を取得できません",
      "invalid_id",
    );
  }
  const cleaned = firstLine.trim();
  if (!FULL_ID_PATTERN.test(cleaned)) {
    throw new HostResourceAdapterError(
      `docker コマンドの stdout から完全 ID（64 文字 hex）を取得できません: ${cleaned.slice(0, 16)}...`,
      "invalid_id",
    );
  }
  return cleaned.toLowerCase();
}

/** JSON 文字列を安全にパースする */
function safeJsonParse(json: string, context: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new HostResourceAdapterError(
      `docker ${context} の JSON パースに失敗しました`,
      "invalid_id",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedInspect(message: string): HostResourceAdapterError {
  return new HostResourceAdapterError(message, "inspect_failed");
}

function parseLabels(value: unknown, context: string): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (!isRecord(value)) {
    throw malformedInspect(`${context} の labels が object ではありません`);
  }
  const labels: Record<string, string> = {};
  for (const [key, labelValue] of Object.entries(value)) {
    if (typeof labelValue !== "string") {
      throw malformedInspect(`${context} の label ${key} が string ではありません`);
    }
    labels[key] = labelValue;
  }
  return labels;
}

function parseContainerInspectJson(stdout: string, expectedId: string): DockerContainerInspectJson {
  const value = safeJsonParse(stdout.trim(), "inspect");
  if (!isRecord(value)) {
    throw malformedInspect("docker inspect の JSON が object ではありません");
  }
  const id = value["Id"];
  if (typeof id !== "string" || !FULL_ID_PATTERN.test(id)) {
    throw new HostResourceAdapterError(
      "docker inspect の JSON から完全な container ID を取得できません",
      "invalid_id",
    );
  }
  if (id.toLowerCase() !== expectedId.toLowerCase()) {
    throw new HostResourceAdapterError(
      "docker inspect の container ID が要求した exact ID と一致しません",
      "invalid_id",
    );
  }

  const stateValue = value["State"];
  if (!isRecord(stateValue) || typeof stateValue["Running"] !== "boolean") {
    throw malformedInspect("docker inspect の State.Running が boolean ではありません");
  }
  const state: DockerInspectState = { Running: stateValue["Running"] };
  const healthValue = stateValue["Health"];
  if (healthValue !== undefined && healthValue !== null) {
    if (!isRecord(healthValue) || typeof healthValue["Status"] !== "string") {
      throw malformedInspect("docker inspect の State.Health.Status が string ではありません");
    }
    state.Health = { Status: healthValue["Status"] };
  }

  const configValue = value["Config"];
  if (!isRecord(configValue)) {
    throw malformedInspect("docker inspect の Config が object ではありません");
  }
  const labels = parseLabels(configValue["Labels"], "docker inspect Config");

  const networkSettingsValue = value["NetworkSettings"];
  if (!isRecord(networkSettingsValue)) {
    throw malformedInspect("docker inspect の NetworkSettings が object ではありません");
  }
  const portsValue = networkSettingsValue["Ports"];
  if (!isRecord(portsValue)) {
    throw malformedInspect("docker inspect の NetworkSettings.Ports が object ではありません");
  }
  const ports: DockerPortsMap = {};
  for (const [key, bindingsValue] of Object.entries(portsValue)) {
    const portKeyMatch = /^([1-9]\d{0,4})\/(?:tcp|udp|sctp)$/.exec(key);
    const containerPort = portKeyMatch === null ? Number.NaN : Number(portKeyMatch[1]);
    if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) {
      throw malformedInspect(`docker inspect の port key が不正です: ${key}`);
    }
    if (bindingsValue === null) {
      ports[key] = null;
      continue;
    }
    if (!Array.isArray(bindingsValue) || bindingsValue.length === 0) {
      throw malformedInspect(`docker inspect の port binding ${key} が空でない配列ではありません`);
    }
    const bindings: DockerPortBinding[] = [];
    for (const bindingValue of bindingsValue) {
      if (
        !isRecord(bindingValue)
        || typeof bindingValue["HostIp"] !== "string"
        || typeof bindingValue["HostPort"] !== "string"
      ) {
        throw malformedInspect(`docker inspect の port binding ${key} が不正です`);
      }
      bindings.push({
        HostIp: bindingValue["HostIp"],
        HostPort: bindingValue["HostPort"],
      });
    }
    ports[key] = bindings;
  }

  const networksValue = networkSettingsValue["Networks"];
  if (!isRecord(networksValue)) {
    throw malformedInspect("docker inspect の NetworkSettings.Networks が object ではありません");
  }
  const networks: Record<string, { NetworkID?: string }> = {};
  for (const [name, networkValue] of Object.entries(networksValue)) {
    if (!isRecord(networkValue) || typeof networkValue["NetworkID"] !== "string") {
      throw malformedInspect(`docker inspect の network ${name} が不正です`);
    }
    validateFullDockerIdFormat(networkValue["NetworkID"]);
    networks[name] = { NetworkID: networkValue["NetworkID"].toLowerCase() };
  }

  return {
    Id: id.toLowerCase(),
    State: state,
    Config: { Labels: labels },
    NetworkSettings: { Ports: ports, Networks: networks },
  };
}

function parseNetworkInspectJson(stdout: string, expectedId: string): DockerNetworkInspectJson {
  const value = safeJsonParse(stdout.trim(), "network inspect");
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    throw malformedInspect("docker network inspect は要素が 1 件の JSON 配列である必要があります");
  }
  const entry = value[0];
  const id = entry["Id"];
  if (typeof id !== "string" || !FULL_ID_PATTERN.test(id)) {
    throw new HostResourceAdapterError(
      "docker network inspect の JSON から完全な network ID を取得できません",
      "invalid_id",
    );
  }
  if (id.toLowerCase() !== expectedId.toLowerCase()) {
    throw new HostResourceAdapterError(
      "docker network inspect の network ID が要求した exact ID と一致しません",
      "invalid_id",
    );
  }
  const name = entry["Name"];
  const driver = entry["Driver"];
  if (typeof name !== "string" || name === "" || typeof driver !== "string" || driver === "") {
    throw malformedInspect("docker network inspect の Name/Driver が不正です");
  }
  const labels = parseLabels(entry["Labels"], "docker network inspect");
  const containersValue = entry["Containers"];
  if (!isRecord(containersValue)) {
    throw malformedInspect("docker network inspect の Containers が object ではありません");
  }
  const containers: Record<string, unknown> = {};
  for (const containerId of Object.keys(containersValue)) {
    validateFullDockerIdFormat(containerId);
    containers[containerId.toLowerCase()] = containersValue[containerId];
  }
  return {
    Id: id.toLowerCase(),
    Name: name,
    Driver: driver,
    Labels: labels,
    Containers: containers,
  };
}

function validateExposedPort(exposePorts: readonly number[]): void {
  if (
    exposePorts.length !== 1
    || !Number.isInteger(exposePorts[0])
    || (exposePorts[0] ?? 0) <= 0
    || (exposePorts[0] ?? 0) > 65535
  ) {
    throw new HostResourceAdapterError(
      "container provision は 1 件の有効な container port に対する host port 0 相当の mapping が必要です",
      "invalid_port",
    );
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

function validateExecutionNonce(executionNonce: string): void {
  if (executionNonce.trim() === "") {
    throw new HostResourceAdapterError(
      "remove には空でない executionNonce が必要です",
      "invalid_argument",
    );
  }
}

function isContainerAbsentDiagnostic(stderr: string): boolean {
  return /(?:^|\s)No such (?:container|object)(?::|\s|$)/i.test(stderr);
}

function isNetworkAbsentDiagnostic(stderr: string): boolean {
  return /(?:^|\s)No such (?:network|object)(?::|\s|$)/i.test(stderr);
}

const ATTACHMENT_OWNER_LABEL_KEYS: readonly string[] = REQUIRED_HACHI_LABEL_KEYS.filter(
  (key) => key !== HACHI_LABELS.OBJECT_FENCE,
);

/** ヘルスチェック設定から docker create の argv フラグを生成する */
function buildHealthCheckFlags(hc: HealthCheckConfig): string[] {
  if (
    hc.command.length === 0
    || hc.command.some((token) => token === "" || /[\s;&|`$()<>\\\r\n]/.test(token))
    || !Number.isInteger(hc.intervalMs)
    || hc.intervalMs <= 0
    || !Number.isInteger(hc.timeoutMs)
    || hc.timeoutMs <= 0
    || !Number.isInteger(hc.retries)
    || hc.retries <= 0
  ) {
    throw new HostResourceAdapterError(
      "healthCheck は shell metacharacter を含まない argv と正の整数設定が必要です",
      "invalid_argument",
    );
  }
  const flags: string[] = [];
  // CMD 形式でヘルスチェックコマンドを構築
  flags.push("--health-cmd", hc.command.join(" "));
  // Docker CLI は "Xs" 形式の duration を受け付ける（最低 1s を保証）
  flags.push("--health-interval", `${String(Math.max(1, Math.ceil(hc.intervalMs / 1000)))}s`);
  // timeout（最低 1s を保証）
  flags.push("--health-timeout", `${String(Math.max(1, Math.ceil(hc.timeoutMs / 1000)))}s`);
  // retries
  flags.push("--health-retries", String(hc.retries));
  return flags;
}

// === DockerHostResourceAdapter ===

/** bounded health polling の待機処理。テストでは無待機 fake を注入する。 */
export type DockerHealthSleep = (delayMs: number) => Promise<void>;

/** DockerHostResourceAdapter のコンストラクタオプション */
export interface DockerHostResourceAdapterOptions {
  /** コマンド実行の DI 注入ポイント */
  commandRunner: CommandRunner;
  /** adapter が固定する Docker context。public API の scopeKey と同一値を要求する。 */
  dockerContext: string;
  /** health=starting の bounded polling 待機処理 */
  healthSleep?: DockerHealthSleep;
}

const DEFAULT_HEALTH_POLL_ATTEMPTS = 31;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 1_000;

async function defaultHealthSleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function attachCreatedResource(
  error: unknown,
  createdResource: CreatedHostResource,
): HostResourceAdapterError {
  if (error instanceof HostResourceAdapterError) {
    return new HostResourceAdapterError(error.message, error.code, createdResource);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HostResourceAdapterError(
    `Docker resource の create 後処理に失敗しました: ${message}`,
    "inspect_failed",
    createdResource,
  );
}

/**
 * Docker CLI を実体とする HostResourceAdapter 実装。
 * argv 配列のみ使用し、シェル文字列は一切構築しない。
 * テスト時は CommandRunner を差し替えて Docker 実体に接触しない。
 */
export class DockerHostResourceAdapter implements HostResourceAdapter {
  private readonly commandRunner: CommandRunner;
  private readonly scopeKey: string;
  private readonly healthSleep: DockerHealthSleep;

  constructor(options: DockerHostResourceAdapterOptions) {
    if (typeof options.dockerContext !== "string" || options.dockerContext.trim() === "") {
      throw new HostResourceAdapterError("dockerContext は空にできません", "scope_mismatch");
    }
    this.commandRunner = options.commandRunner;
    this.scopeKey = options.dockerContext;
    this.healthSleep = options.healthSleep ?? defaultHealthSleep;
  }

  // === docker コマンドの基本 argv 構築 ===

  /** docker コマンドの基本 argv を構築する（context フラグ付き） */
  private baseArgv(): string[] {
    return ["docker", "--context", this.scopeKey];
  }

  /** 呼び出し側の scope とこの adapter に固定された Docker context scope を照合する。 */
  private validateScope(scopeKey: string): void {
    if (scopeKey !== this.scopeKey) {
      throw new HostResourceAdapterError(
        `Docker scope が adapter と一致しません: expected=${this.scopeKey}`,
        "scope_mismatch",
      );
    }
  }

  // === HostResourceAdapter implementation ===

  async provisionContainer(params: ProvisionContainerParams): Promise<ProvisionContainerResult> {
    this.validateScope(params.scopeKey);
    validateRequiredLabels(params.labels);
    validateComposeProvenance(params.labels, params.composeProject, "container");
    validateExposedPort(params.exposePorts);
    if (params.networkId !== undefined) {
      validateFullDockerIdFormat(params.networkId);
    }
    // 2. docker create argv の構築
    const createArgv = [...this.baseArgv(), "create"];

    if (params.readOnlyBindMounts !== undefined) {
      for (const mount of params.readOnlyBindMounts) {
        if (
          !isAbsolute(mount.sourcePath) ||
          !isAbsolute(mount.targetPath) ||
          /[\r\n,]/u.test(mount.sourcePath) ||
          /[\r\n,]/u.test(mount.targetPath)
        ) {
          throw new HostResourceAdapterError("read-only bind mount path が不正です", "invalid_argument");
        }
        createArgv.push("--mount", `type=bind,src=${mount.sourcePath},dst=${mount.targetPath},readonly`);
      }
    }

    // ラベルフラグ
    for (const [key, value] of Object.entries(params.labels)) {
      createArgv.push("--label", `${key}=${value}`);
    }

    // 環境変数フラグ
    if (params.env !== undefined) {
      for (const [key, value] of Object.entries(params.env)) {
        createArgv.push("-e", `${key}=${value}`);
      }
    }

    // ポートバインド（127.0.0.1 の ephemeral ポートにバインド）
    for (const containerPort of params.exposePorts) {
      createArgv.push("-p", `127.0.0.1::${String(containerPort)}`);
    }

    // ヘルスチェック設定
    if (params.healthCheck !== undefined) {
      createArgv.push(...buildHealthCheckFlags(params.healthCheck));
    }

    // ネットワーク接続
    if (params.networkId !== undefined) {
      createArgv.push("--network", params.networkId);
    }

    // イメージ名
    createArgv.push(params.image);

    // 3. docker create 実行 → container ID 取得
    const createResult = await this.commandRunner.run(createArgv);
    if (createResult.exitCode !== 0) {
      throw new HostResourceAdapterError(
        `docker create が失敗しました (exit ${String(createResult.exitCode)}): ${createResult.stderr}`,
        "invalid_id",
      );
    }
    const containerId = parseDockerIdFromStdout(createResult.stdout);
    const createdResource: CreatedHostResource = {
      kind: "docker_container",
      nativeId: containerId,
      scopeKey: this.scopeKey,
      labels: { ...params.labels },
    };

    try {
      // 4. docker start 実行
      const startArgv = [...this.baseArgv(), "start", containerId];
      const startResult = await this.commandRunner.run(startArgv);
      if (startResult.exitCode !== 0) {
        throw new HostResourceAdapterError(
          `docker start が失敗しました (exit ${String(startResult.exitCode)}): ${startResult.stderr}`,
          "inspect_failed",
        );
      }

      const maxAttempts = params.healthCheck === undefined
        ? DEFAULT_HEALTH_POLL_ATTEMPTS
        : params.healthCheck.retries + 1;
      const intervalMs = params.healthCheck?.intervalMs ?? DEFAULT_HEALTH_POLL_INTERVAL_MS;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        // 5. fresh docker inspect と identity/provenance/port/attachment の再照合
        const inspectArgv = [
          ...this.baseArgv(),
          "inspect",
          "--format",
          "{{json .}}",
          containerId,
        ];
        const inspectResult = await this.commandRunner.run(inspectArgv);
        if (inspectResult.exitCode !== 0) {
          throw new HostResourceAdapterError(
            `docker inspect が失敗しました (exit ${String(inspectResult.exitCode)}): ${inspectResult.stderr}`,
            "inspect_failed",
          );
        }

        const inspectJson = parseContainerInspectJson(inspectResult.stdout, containerId);
        const inspectedId = inspectJson.Id;
        if (inspectedId === undefined) {
          throw malformedInspect("docker inspect の container ID が欠落しています");
        }
        const portMappings = this.extractPortMappings(inspectJson, params.exposePorts);
        if (inspectJson.State?.Running !== true) {
          throw new HostResourceAdapterError(
            "provision 後の container が running ではありません",
            "unhealthy",
          );
        }

        const actualLabels = inspectJson.Config?.Labels ?? {};
        const { matched, mismatches } = verifyLabelsMatch(actualLabels, params.labels);
        if (!matched) {
          throw new HostResourceAdapterError(
            `provision 後のラベル検証に失敗しました。不一致キー: ${mismatches.join(", ")}`,
            "label_mismatch",
          );
        }
        validateComposeProvenance(actualLabels, params.composeProject, "container");

        if (params.networkId !== undefined) {
          const actualNetworkIds = Object.values(inspectJson.NetworkSettings?.Networks ?? {})
            .map((network) => network?.NetworkID)
            .filter((networkId): networkId is string => networkId !== undefined);
          if (
            actualNetworkIds.length !== 1
            || actualNetworkIds[0] !== params.networkId.toLowerCase()
          ) {
            throw new HostResourceAdapterError(
              "provision 後の network attachment が要求した exact network ID と一致しません",
              "invalid_id",
            );
          }
        } else {
          const actualNetworks = Object.entries(inspectJson.NetworkSettings?.Networks ?? {});
          const bridgeEntry = actualNetworks[0];
          if (
            actualNetworks.length !== 1
            || bridgeEntry === undefined
            || bridgeEntry[0] !== "bridge"
            || bridgeEntry[1] === undefined
            || bridgeEntry[1].NetworkID === undefined
          ) {
            throw new HostResourceAdapterError(
              "provision 後の container が Docker built-in bridge のみに接続されていることを検証できません",
              "inspect_failed",
            );
          }
        }

        const healthStatus = inspectJson.State.Health?.Status;
        if (healthStatus === "starting" && attempt < maxAttempts) {
          await this.healthSleep(intervalMs);
          continue;
        }
        if (healthStatus !== "healthy") {
          throw new HostResourceAdapterError(
            `provision 後の container health が healthy ではありません: ${healthStatus ?? "missing"}`,
            "unhealthy",
          );
        }

        return {
          nativeId: inspectedId.toLowerCase(),
          portMappings,
          labels: { ...actualLabels },
          healthy: true,
        };
      }
      throw new HostResourceAdapterError(
        "provision 後の container health polling が上限に到達しました",
        "unhealthy",
      );
    } catch (error) {
      throw attachCreatedResource(error, createdResource);
    }
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

    // 2. docker network create argv の構築
    const createArgv = [...this.baseArgv(), "network", "create"];

    // ラベルフラグ
    for (const [key, value] of Object.entries(params.labels)) {
      createArgv.push("--label", `${key}=${value}`);
    }

    // ドライバ指定
    const driver = params.driver ?? "bridge";
    validateManagedNetworkDriver(driver);
    createArgv.push("--driver", driver);

    // ネットワーク名
    createArgv.push(params.name);

    // 3. docker network create 実行 → network ID 取得
    const createResult = await this.commandRunner.run(createArgv);
    if (createResult.exitCode !== 0) {
      throw new HostResourceAdapterError(
        `docker network create が失敗しました (exit ${String(createResult.exitCode)}): ${createResult.stderr}`,
        "invalid_id",
      );
    }
    const networkId = parseDockerIdFromStdout(createResult.stdout);
    const createdResource: CreatedHostResource = {
      kind: "docker_network",
      nativeId: networkId,
      scopeKey: this.scopeKey,
      labels: { ...params.labels },
    };

    try {
      // 4. docker network inspect で identity/provenance を再照合
      const inspectArgv = [...this.baseArgv(), "network", "inspect", networkId];
      const inspectResult = await this.commandRunner.run(inspectArgv);
      if (inspectResult.exitCode !== 0) {
        throw new HostResourceAdapterError(
          `docker network inspect が失敗しました (exit ${String(inspectResult.exitCode)}): ${inspectResult.stderr}`,
          "inspect_failed",
        );
      }

      const inspectJson = parseNetworkInspectJson(inspectResult.stdout, networkId);
      if (inspectJson.Name !== params.name || inspectJson.Driver !== driver) {
        throw malformedInspect("network provision 後の Name/Driver が要求と一致しません");
      }

      const actualLabels = inspectJson.Labels ?? {};
      const { matched, mismatches } = verifyLabelsMatch(actualLabels, params.labels);
      if (!matched) {
        throw new HostResourceAdapterError(
          `network provision 後のラベル検証に失敗しました。不一致キー: ${mismatches.join(", ")}`,
          "label_mismatch",
        );
      }
      validateComposeProvenance(actualLabels, params.composeProject, "network");

      return {
        nativeId: networkId,
        labels: { ...actualLabels },
      };
    } catch (error) {
      throw attachCreatedResource(error, createdResource);
    }
  }

  async inspectContainer(
    nativeId: string,
    scopeKey: string,
    options?: CommandRunnerOptions,
  ): Promise<ContainerInspection | null> {
    validateFullDockerIdFormat(nativeId);
    this.validateScope(scopeKey);

    // 2. docker inspect 実行
    const inspectArgv = [...this.baseArgv(), "inspect", "--format", "{{json .}}", nativeId];
    const inspectResult = await this.commandRunner.run(inspectArgv, options);

    // 存在しない場合は null を返す
    if (inspectResult.exitCode !== 0) {
      if (isContainerAbsentDiagnostic(inspectResult.stderr)) return null;
      throw new HostResourceAdapterError(
        `docker inspect が失敗しました (exit ${String(inspectResult.exitCode)}): ${inspectResult.stderr}`,
        "inspect_failed",
      );
    }

    // 3. JSON パースと情報抽出
    const inspectJson = parseContainerInspectJson(inspectResult.stdout, nativeId);

    const running = inspectJson.State?.Running ?? false;

    // ヘルスステータスの抽出
    const healthObj = inspectJson.State?.Health;
    let healthy: boolean | null;
    if (healthObj === undefined) {
      healthy = null;
    } else {
      healthy = healthObj.Status === "healthy";
    }

    // ラベルの抽出
    const labels = inspectJson.Config?.Labels ?? {};

    // ポートマッピングの抽出（wildcard・不正値は fail-closed）
    const portMappings = this.extractPortMappingsSafe(inspectJson);

    // ネットワーク ID の抽出
    const networkIds: string[] = [];
    const networks = inspectJson.NetworkSettings?.Networks;
    if (networks !== undefined) {
      for (const netInfo of Object.values(networks)) {
        if (netInfo === undefined) continue;
        const netId = netInfo.NetworkID;
        if (netId !== undefined && netId !== "") {
          networkIds.push(netId);
        }
      }
    }

    return {
      nativeId: nativeId.toLowerCase(),
      scopeKey: this.scopeKey,
      running,
      healthy,
      labels: { ...labels },
      portMappings,
      networkIds,
      observedAt: Date.now(),
    };
  }

  async inspectNetwork(
    nativeId: string,
    scopeKey: string,
    options?: CommandRunnerOptions,
  ): Promise<NetworkInspection | null> {
    validateFullDockerIdFormat(nativeId);
    this.validateScope(scopeKey);

    // 2. docker network inspect 実行
    const inspectArgv = [...this.baseArgv(), "network", "inspect", nativeId];
    const inspectResult = await this.commandRunner.run(inspectArgv, options);

    // 存在しない場合は null を返す
    if (inspectResult.exitCode !== 0) {
      if (isNetworkAbsentDiagnostic(inspectResult.stderr)) return null;
      throw new HostResourceAdapterError(
        `docker network inspect が失敗しました (exit ${String(inspectResult.exitCode)}): ${inspectResult.stderr}`,
        "inspect_failed",
      );
    }

    // 3. JSON パースと情報抽出
    const inspectJson = parseNetworkInspectJson(inspectResult.stdout, nativeId);

    // ラベルの抽出
    const labels = inspectJson.Labels ?? {};

    // 接続中 container ID の抽出
    const connectedContainerIds: string[] = [];
    const containers = inspectJson.Containers;
    if (containers !== undefined) {
      for (const containerId of Object.keys(containers)) {
        connectedContainerIds.push(containerId);
      }
    }

    // ドライバの抽出
    const driver = inspectJson.Driver ?? "bridge";

    // built-in bridge の検出
    const name = inspectJson.Name ?? "";
    const isBuiltInBridge = name === "bridge" && driver === "bridge";

    return {
      nativeId: nativeId.toLowerCase(),
      scopeKey: this.scopeKey,
      labels: { ...labels },
      connectedContainerIds,
      isBuiltInBridge,
      driver,
      observedAt: Date.now(),
    };
  }

  async removeContainer(params: RemoveContainerParams, options?: CommandRunnerOptions): Promise<RemoveResult> {
    validateFullDockerIdFormat(params.nativeId);
    this.validateScope(params.scopeKey);
    validateExpectedLabelsForRemoval(params.expectedLabels, "container");
    validateExecutionNonce(params.executionNonce);

    // 2. fresh inspect
    const inspection = await this.inspectContainer(params.nativeId, params.scopeKey, options);

    // 3. 存在しない → 冪等回復
    if (inspection === null) {
      return { status: "already_absent", nativeId: params.nativeId };
    }

    // 4. ラベル検証（fail-closed）
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

    // 5. managed=true の検証
    if (inspection.labels[HACHI_LABELS.MANAGED] !== "true") {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `${HACHI_LABELS.MANAGED} が "true" ではありません`,
      };
    }

    // attachment drift を fresh inspect し、built-in bridge または同一 owner の managed network
    // 1 件だけに接続されている場合に限って削除を許可する。
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
      throw malformedInspect("container の network attachment ID が欠落しています");
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
        const ownerMatch = verifyLabelsMatch(attachedNetwork.labels, expectedOwnerLabels);
        if (!ownerMatch.matched) {
          return {
            status: "label_mismatch",
            nativeId: params.nativeId,
            lastInspection: inspection,
            failureDetail: `attachment 先 network の owner/provenance 不一致: ${ownerMatch.mismatches.join(", ")}`,
          };
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

    // 6. docker rm -f 実行（完全 ID のみ argv に渡す）
    validateFullDockerIdFormat(inspection.nativeId);
    const rmArgv = [...this.baseArgv(), "rm", "-f", inspection.nativeId];
    const rmResult = await this.commandRunner.run(rmArgv, options);
    if (rmResult.exitCode !== 0) {
      throw new HostResourceAdapterError(
        `docker rm -f が失敗しました (exit ${String(rmResult.exitCode)}): ${rmResult.stderr}`,
        "inspect_failed",
      );
    }

    const absentInspection = await this.inspectContainer(inspection.nativeId, params.scopeKey, options);
    if (absentInspection !== null) {
      throw new HostResourceAdapterError(
        "docker rm -f 後も同じ exact container ID が存在します",
        "inspect_failed",
      );
    }

    return {
      status: "removed",
      nativeId: params.nativeId,
      lastInspection: inspection,
    };
  }

  async removeNetwork(params: RemoveNetworkParams, options?: CommandRunnerOptions): Promise<RemoveResult> {
    validateFullDockerIdFormat(params.nativeId);
    this.validateScope(params.scopeKey);
    validateExpectedLabelsForRemoval(params.expectedLabels, "network");
    validateExecutionNonce(params.executionNonce);

    // expectedAbsentContainerIds の完全 ID 検証
    for (const containerId of params.expectedAbsentContainerIds) {
      validateFullDockerIdFormat(containerId);
    }

    // 2. fresh inspect
    const inspection = await this.inspectNetwork(params.nativeId, params.scopeKey, options);

    // 3. 存在しない → 冪等回復
    if (inspection === null) {
      return { status: "already_absent", nativeId: params.nativeId };
    }

    // 4. built-in bridge 保護
    if (inspection.isBuiltInBridge) {
      return {
        status: "bridge_protected",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: "built-in bridge network は削除できません",
      };
    }
    validateManagedNetworkDriver(inspection.driver);

    // 5. ラベル検証（fail-closed）
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

    // 6. managed=true の検証
    if (inspection.labels[HACHI_LABELS.MANAGED] !== "true") {
      return {
        status: "label_mismatch",
        nativeId: params.nativeId,
        lastInspection: inspection,
        failureDetail: `${HACHI_LABELS.MANAGED} が "true" ではありません`,
      };
    }

    // 7. expectedAbsentContainerIds が全て存在しないことを検証
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

    // 8. fresh inspect を再取得し、接続中 container がないことを検証
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

    // 9. docker network rm 実行（完全 ID のみ argv に渡す）
    validateFullDockerIdFormat(freshInspection.nativeId);
    const rmArgv = [...this.baseArgv(), "network", "rm", freshInspection.nativeId];
    const rmResult = await this.commandRunner.run(rmArgv, options);
    if (rmResult.exitCode !== 0) {
      throw new HostResourceAdapterError(
        `docker network rm が失敗しました (exit ${String(rmResult.exitCode)}): ${rmResult.stderr}`,
        "inspect_failed",
      );
    }

    const absentInspection = await this.inspectNetwork(freshInspection.nativeId, params.scopeKey, options);
    if (absentInspection !== null) {
      throw new HostResourceAdapterError(
        "docker network rm 後も同じ exact network ID が存在します",
        "inspect_failed",
      );
    }

    return {
      status: "removed",
      nativeId: params.nativeId,
      lastInspection: inspection,
    };
  }

  // === ポートマッピング抽出ヘルパー ===

  /**
   * provision 時のポートマッピング抽出。
   * 各 exposed port に対して exactly 1 つの 127.0.0.1 バインディングを要求する。
   * 違反時は HostResourceAdapterError を投げる。
   */
  private extractPortMappings(
    inspectJson: DockerContainerInspectJson,
    exposedPorts: readonly number[],
  ): PortMapping[] {
    const portsMap = inspectJson.NetworkSettings?.Ports;
    if (portsMap === undefined) {
      throw new HostResourceAdapterError(
        "docker inspect の JSON に NetworkSettings.Ports が存在しません",
        "invalid_port",
      );
    }

    const portMappings: PortMapping[] = [];
    const actualBindings = Object.values(portsMap).reduce(
      (count, bindings) => count + (bindings?.length ?? 0),
      0,
    );
    if (actualBindings !== 1) {
      throw new HostResourceAdapterError(
        `provision 後の host port mapping は全体で 1 件である必要があります: ${String(actualBindings)} 件`,
        "invalid_port",
      );
    }

    for (const containerPort of exposedPorts) {
      // Docker は "5432/tcp" 形式のキーを使用する
      const key = `${String(containerPort)}/tcp`;
      const bindings = portsMap[key];

      if (bindings === undefined || bindings === null || bindings.length === 0) {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} のバインディングが見つかりません`,
          "invalid_port",
        );
      }

      // 複数バインディングは拒否
      if (bindings.length !== 1) {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} に複数のバインディングがあります（${String(bindings.length)} 件）。1 件のみ許可されます`,
          "invalid_port",
        );
      }

      const binding = bindings[0];
      if (binding === undefined) {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} のバインディングデータが不正です`,
          "invalid_port",
        );
      }

      const hostIp = binding.HostIp;
      const hostPortStr = binding.HostPort;

      // HostIp の検証: 127.0.0.1 のみ許可
      if (hostIp === undefined || hostIp === "") {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} の HostIp が未設定です`,
          "wildcard_bind",
        );
      }
      if (hostIp === "0.0.0.0") {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} が wildcard 0.0.0.0 にバインドされています。127.0.0.1 のみ許可されます`,
          "wildcard_bind",
        );
      }
      if (hostIp !== "127.0.0.1") {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} の HostIp が 127.0.0.1 ではありません: ${hostIp}`,
          "wildcard_bind",
        );
      }

      // HostPort の検証
      if (hostPortStr === undefined || hostPortStr === "") {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} の HostPort が未設定です`,
          "invalid_port",
        );
      }
      if (!/^\d+$/.test(hostPortStr)) {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} の HostPort が無効です: ${hostPortStr}`,
          "invalid_port",
        );
      }
      const hostPort = Number(hostPortStr);
      if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65535) {
        throw new HostResourceAdapterError(
          `container port ${String(containerPort)} の HostPort が無効です: ${hostPortStr}`,
          "invalid_port",
        );
      }

      portMappings.push({
        containerPort,
        hostIp: "127.0.0.1",
        hostPort,
      });
    }

    return portMappings;
  }

  /**
   * inspect 時のポートマッピング抽出。
   * wildcard・不正 port は観測から隠さず fail-closed で拒否する。
   */
  private extractPortMappingsSafe(inspectJson: DockerContainerInspectJson): PortMapping[] {
    const portsMap = inspectJson.NetworkSettings?.Ports;
    if (portsMap === undefined) {
      return [];
    }

    const portMappings: PortMapping[] = [];

    for (const [key, bindings] of Object.entries(portsMap)) {
      if (bindings === undefined || bindings === null) continue;

      // キーから container port を抽出（"5432/tcp" → 5432）
      const portMatch = /^([1-9]\d{0,4})\/(?:tcp|udp|sctp)$/.exec(key);
      if (portMatch === null) {
        throw malformedInspect(`docker inspect の port key が不正です: ${key}`);
      }
      const containerPortStr = portMatch[1];
      if (containerPortStr === undefined) {
        throw malformedInspect(`docker inspect の port key が不正です: ${key}`);
      }
      const containerPort = Number(containerPortStr);
      if (!Number.isInteger(containerPort) || containerPort <= 0 || containerPort > 65535) {
        throw malformedInspect(`docker inspect の container port が範囲外です: ${key}`);
      }

      for (const binding of bindings) {
        if (binding === undefined) continue;
        const hostIp = binding.HostIp;
        const hostPortStr = binding.HostPort;

        if (hostIp !== "127.0.0.1") {
          throw new HostResourceAdapterError(
            `inspect した container port ${String(containerPort)} が wildcard/未知 IP に bind されています: ${hostIp ?? ""}`,
            "wildcard_bind",
          );
        }
        if (hostPortStr === undefined || !/^\d+$/.test(hostPortStr)) {
          throw new HostResourceAdapterError(
            `inspect した container port ${String(containerPort)} の HostPort が不正です`,
            "invalid_port",
          );
        }

        const hostPort = Number(hostPortStr);
        if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65535) {
          throw new HostResourceAdapterError(
            `inspect した container port ${String(containerPort)} の HostPort が範囲外です`,
            "invalid_port",
          );
        }

        portMappings.push({
          containerPort,
          hostIp: "127.0.0.1",
          hostPort,
        });
      }
    }

    return portMappings;
  }
}
