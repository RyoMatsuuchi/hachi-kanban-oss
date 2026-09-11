// === Hachi required labels ===

/** Hachi が Docker object に付与する所有・provenance ラベルキー */
export const HACHI_LABELS = {
  MANAGED: "io.hachi.managed",
  EPHEMERAL: "io.hachi.ephemeral",
  PROVENANCE_VERSION: "io.hachi.provenance-version",
  LEASE_ID: "io.hachi.lease-id",
  OBJECT_FENCE: "io.hachi.object-fence",
  BOARD: "io.hachi.board",
  TASK_ID: "io.hachi.task-id",
  RUN_ID: "io.hachi.run-id",
  ORCHESTRATOR_ID: "io.hachi.orchestrator-id",
  REPO_COMMON_DIR_HASH: "io.hachi.repo-common-dir-hash",
  WORKTREE_HASH: "io.hachi.worktree-hash",
  BUNDLE_KIND: "io.hachi.bundle-kind",
  ROLLOUT_GENERATION: "io.hachi.rollout-generation",
} as const;

/** Compose 標準ラベルキー */
export const COMPOSE_LABELS = {
  PROJECT: "com.docker.compose.project",
  SERVICE: "com.docker.compose.service",
  CONTAINER_NUMBER: "com.docker.compose.container-number",
  ONEOFF: "com.docker.compose.oneoff",
  NETWORK: "com.docker.compose.network",
  VERSION: "com.docker.compose.version",
} as const;

const COMPOSE_CONTAINER_PROVENANCE_KEYS: readonly string[] = [
  COMPOSE_LABELS.PROJECT,
  COMPOSE_LABELS.SERVICE,
  COMPOSE_LABELS.CONTAINER_NUMBER,
  COMPOSE_LABELS.ONEOFF,
  COMPOSE_LABELS.VERSION,
];

const COMPOSE_NETWORK_PROVENANCE_KEYS: readonly string[] = [
  COMPOSE_LABELS.PROJECT,
  COMPOSE_LABELS.NETWORK,
  COMPOSE_LABELS.VERSION,
];

const COMPOSE_PROVENANCE_KEYS: readonly string[] = [
  ...new Set([...COMPOSE_CONTAINER_PROVENANCE_KEYS, ...COMPOSE_NETWORK_PROVENANCE_KEYS]),
];

/** managed resource に必須の Hachi ラベルキー一覧 */
export const REQUIRED_HACHI_LABEL_KEYS: readonly string[] = [
  HACHI_LABELS.MANAGED,
  HACHI_LABELS.EPHEMERAL,
  HACHI_LABELS.PROVENANCE_VERSION,
  HACHI_LABELS.LEASE_ID,
  HACHI_LABELS.OBJECT_FENCE,
  HACHI_LABELS.BOARD,
  HACHI_LABELS.TASK_ID,
  HACHI_LABELS.RUN_ID,
  HACHI_LABELS.ORCHESTRATOR_ID,
  HACHI_LABELS.REPO_COMMON_DIR_HASH,
  HACHI_LABELS.WORKTREE_HASH,
  HACHI_LABELS.BUNDLE_KIND,
  HACHI_LABELS.ROLLOUT_GENERATION,
];

// === Port mapping ===

export interface PortMapping {
  /** コンテナ側ポート */
  containerPort: number;
  /** ホスト側 IP（常に "127.0.0.1"） */
  hostIp: string;
  /** Docker が割り当てた ephemeral ホストポート */
  hostPort: number;
}

// === Health check ===

export interface HealthCheckConfig {
  /** ヘルスチェックコマンド */
  command: readonly string[];
  /** 実行間隔（ミリ秒） */
  intervalMs: number;
  /** タイムアウト（ミリ秒） */
  timeoutMs: number;
  /** リトライ回数 */
  retries: number;
}

// === Provision params / results ===

export interface ProvisionContainerParams {
  /** Docker context（scope key） */
  scopeKey: string;
  /** コンテナイメージ */
  image: string;
  /** Hachi 所有ラベル（required labels 全て含む） */
  labels: Readonly<Record<string, string>>;
  /** 環境変数 */
  env?: Readonly<Record<string, string>>;
  /** host が発行した scoped secret file の read-only bind mount */
  readOnlyBindMounts?: readonly ReadonlyBindMount[];
  /** host port 0 でバインドする container port の一覧 */
  exposePorts: readonly number[];
  /** 接続する network の完全 ID（built-in bridge を除く） */
  networkId?: string;
  /** ヘルスチェック設定 */
  healthCheck?: HealthCheckConfig;
  /** Compose project 名 */
  composeProject?: string;
}

export interface ReadonlyBindMount {
  /** host 側の containment 検証済み絶対 path */
  sourcePath: string;
  /** container 側の絶対 path */
  targetPath: string;
}

export interface ProvisionContainerResult {
  /** Docker container の完全 ID（64 文字 hex） */
  nativeId: string;
  /** 割り当てられた host port mapping */
  portMappings: readonly PortMapping[];
  /** provision 時の labels snapshot */
  labels: Readonly<Record<string, string>>;
  /** container が healthy かどうか（healthCheck 未設定時は true） */
  healthy: boolean;
}

export interface ProvisionNetworkParams {
  /** Docker context（scope key） */
  scopeKey: string;
  /** ネットワーク名 */
  name: string;
  /** Hachi 所有ラベル */
  labels: Readonly<Record<string, string>>;
  /** ネットワークドライバ（既定 "bridge"） */
  driver?: string;
  /** Compose project 名 */
  composeProject?: string;
}

export interface ProvisionNetworkResult {
  /** Docker network の完全 ID（64 文字 hex） */
  nativeId: string;
  /** provision 時の labels snapshot */
  labels: Readonly<Record<string, string>>;
}

// === Inspection types ===

export interface ContainerInspection {
  /** 完全 container ID */
  nativeId: string;
  /** Docker context */
  scopeKey: string;
  /** 実行中かどうか */
  running: boolean;
  /** ヘルスチェック結果（未設定の場合 null） */
  healthy: boolean | null;
  /** 現在の labels */
  labels: Readonly<Record<string, string>>;
  /** ポートマッピング */
  portMappings: readonly PortMapping[];
  /** 接続中の network ID 一覧 */
  networkIds: readonly string[];
  /** 観測時刻 */
  observedAt: number;
}

export interface NetworkInspection {
  /** 完全 network ID */
  nativeId: string;
  /** Docker context */
  scopeKey: string;
  /** 現在の labels */
  labels: Readonly<Record<string, string>>;
  /** 接続中の container ID 一覧 */
  connectedContainerIds: readonly string[];
  /** built-in bridge かどうか */
  isBuiltInBridge: boolean;
  /** ネットワークドライバ */
  driver: string;
  /** 観測時刻 */
  observedAt: number;
}

// === Remove types ===

export interface RemoveContainerParams {
  /** 完全 native ID */
  nativeId: string;
  /** Docker context */
  scopeKey: string;
  /** 期待するラベル（provenance 検証用） */
  expectedLabels: Readonly<Record<string, string>>;
  /** execution nonce（intent-before-effect 記録用） */
  executionNonce: string;
}

export interface RemoveNetworkParams {
  /** 完全 native ID */
  nativeId: string;
  /** Docker context */
  scopeKey: string;
  /** 期待するラベル（provenance 検証用） */
  expectedLabels: Readonly<Record<string, string>>;
  /** execution nonce */
  executionNonce: string;
  /** 所属 container が全て削除済みであることを検証する container ID 一覧 */
  expectedAbsentContainerIds: readonly string[];
}

/** remove 操作の結果ステータス */
export type RemoveResultStatus =
  | "removed"            // 正常削除
  | "already_absent"     // 既に存在しない（冪等回復）
  | "label_mismatch"     // ラベル不一致で fail-closed
  | "bridge_protected"   // built-in bridge は削除禁止
  | "volume_protected"   // volume は v1 で削除禁止
  | "containers_remain"; // network に接続中 container が残存

export interface RemoveResult {
  /** 結果ステータス */
  status: RemoveResultStatus;
  /** 対象の native ID */
  nativeId: string;
  /** 削除前の最終 inspection（存在した場合） */
  lastInspection?: ContainerInspection | NetworkInspection;
  /** 失敗時の詳細 */
  failureDetail?: string;
}

/** provision が部分成功した際に呼び出し側が永続化する作成済み resource identity。 */
export interface CreatedHostResource {
  kind: "docker_container" | "docker_network";
  nativeId: string;
  scopeKey: string;
  labels: Readonly<Record<string, string>>;
}

/** host I/O を supervisor tick の期限へ拘束する制御。 */
export interface HostResourceOperationOptions {
  signal?: AbortSignal;
}

// === Adapter interface ===

/**
 * ホスト実体への provision/inspect/remove 境界。
 * exact ID のみを受け付け、列挙・名前推測に依存しない。
 * Docker side effect は host supervisor の resource-cleanup stage だけが呼ぶ。（§56.2）
 */
export interface HostResourceAdapter {
  /** Docker container を provision し、完全 ID・host port mapping・labels を返す */
  provisionContainer(params: ProvisionContainerParams): Promise<ProvisionContainerResult>;

  /** Docker network を provision し、完全 ID を返す */
  provisionNetwork(params: ProvisionNetworkParams): Promise<ProvisionNetworkResult>;

  /** 完全 ID で container を fresh inspect する。存在しなければ null */
  inspectContainer(
    nativeId: string,
    scopeKey: string,
    options?: HostResourceOperationOptions,
  ): Promise<ContainerInspection | null>;

  /** 完全 ID で network を fresh inspect する。存在しなければ null */
  inspectNetwork(
    nativeId: string,
    scopeKey: string,
    options?: HostResourceOperationOptions,
  ): Promise<NetworkInspection | null>;

  /**
   * 検証済み完全 ID の container を remove する。
   * remove 前に fresh inspect + label 検証を必須とする。
   * label 不一致は fail-closed で拒否。
   */
  removeContainer(params: RemoveContainerParams, options?: HostResourceOperationOptions): Promise<RemoveResult>;

  /**
   * 検証済み完全 ID の network を remove する。
   * member container が消えたことを再検証してから削除する。
   * built-in bridge は拒否する。
   */
  removeNetwork(params: RemoveNetworkParams, options?: HostResourceOperationOptions): Promise<RemoveResult>;
}

// === Validation ===

/** host resource adapter のドメインエラー */
export class HostResourceAdapterError extends Error {
  constructor(
    message: string,
    /** エラーコード */
    readonly code:
      | "missing_labels"
      | "label_mismatch"
      | "bridge_protected"
      | "volume_protected"
      | "invalid_id"
      | "invalid_port"
      | "wildcard_bind"
      | "scope_mismatch"
      | "inspect_failed"
      | "unhealthy"
      | "invalid_argument",
    /** create 後に失敗した場合の、cleanup_pending 化に必要な作成済み exact identity。 */
    readonly createdResource?: CreatedHostResource,
  ) {
    super(message);
    this.name = "HostResourceAdapterError";
  }
}

const NON_EMPTY_HACHI_LABEL_KEYS: readonly string[] = REQUIRED_HACHI_LABEL_KEYS.filter(
  (key) => key !== HACHI_LABELS.RUN_ID,
);

const REMOVABLE_BUNDLE_KINDS = new Set(["worktree_postgres", "worktree_preview"]);

function isPositiveIntegerString(value: string | undefined): boolean {
  return value !== undefined && /^[1-9]\d*$/.test(value);
}

/** managed resource の required Hachi labels と provenance 値を検証する。 */
export function validateRequiredLabels(labels: Readonly<Record<string, string>>): void {
  const missing = REQUIRED_HACHI_LABEL_KEYS.filter((key) => labels[key] === undefined);
  if (missing.length > 0) {
    throw new HostResourceAdapterError(
      `required Hachi labels が不足しています: ${missing.join(", ")}`,
      "missing_labels",
    );
  }
  if (labels[HACHI_LABELS.MANAGED] !== "true") {
    throw new HostResourceAdapterError(
      `${HACHI_LABELS.MANAGED} は "true" である必要があります`,
      "label_mismatch",
    );
  }
  if (labels[HACHI_LABELS.EPHEMERAL] !== "true") {
    throw new HostResourceAdapterError(
      `${HACHI_LABELS.EPHEMERAL} は "true" である必要があります`,
      "label_mismatch",
    );
  }
  const empty = NON_EMPTY_HACHI_LABEL_KEYS.filter((key) => labels[key] === "");
  if (empty.length > 0) {
    throw new HostResourceAdapterError(
      `required Hachi labels に空文字を使用できません: ${empty.join(", ")}`,
      "missing_labels",
    );
  }
  if (!isPositiveIntegerString(labels[HACHI_LABELS.PROVENANCE_VERSION])) {
    throw new HostResourceAdapterError(
      `${HACHI_LABELS.PROVENANCE_VERSION} は正の整数である必要があります`,
      "label_mismatch",
    );
  }
  if (!isPositiveIntegerString(labels[HACHI_LABELS.OBJECT_FENCE])) {
    throw new HostResourceAdapterError(
      `${HACHI_LABELS.OBJECT_FENCE} は正の整数である必要があります`,
      "label_mismatch",
    );
  }
  if (!isPositiveIntegerString(labels[HACHI_LABELS.ROLLOUT_GENERATION])) {
    throw new HostResourceAdapterError(
      `${HACHI_LABELS.ROLLOUT_GENERATION} は正の整数である必要があります`,
      "label_mismatch",
    );
  }
  for (const hashKey of [HACHI_LABELS.REPO_COMMON_DIR_HASH, HACHI_LABELS.WORKTREE_HASH]) {
    const hash = labels[hashKey];
    if (hash === undefined || !/^[\da-f]{64}$/i.test(hash)) {
      throw new HostResourceAdapterError(
        `${hashKey} は 64 文字の SHA-256 hex である必要があります`,
        "label_mismatch",
      );
    }
  }
  const emptyComposeLabels = COMPOSE_PROVENANCE_KEYS.filter(
    (key) => labels[key] !== undefined && labels[key]?.trim() === "",
  );
  if (emptyComposeLabels.length > 0) {
    throw new HostResourceAdapterError(
      `Compose provenance labels に空文字を使用できません: ${emptyComposeLabels.join(", ")}`,
      "label_mismatch",
    );
  }
}

function validateComposeLabelValues(labels: Readonly<Record<string, string>>): void {
  const containerNumber = labels[COMPOSE_LABELS.CONTAINER_NUMBER];
  if (containerNumber !== undefined && !isPositiveIntegerString(containerNumber)) {
    throw new HostResourceAdapterError(
      `${COMPOSE_LABELS.CONTAINER_NUMBER} は正の整数である必要があります`,
      "label_mismatch",
    );
  }
  const oneoff = labels[COMPOSE_LABELS.ONEOFF];
  if (oneoff !== undefined && !/^(?:true|false)$/i.test(oneoff)) {
    throw new HostResourceAdapterError(
      `${COMPOSE_LABELS.ONEOFF} は true/false である必要があります`,
      "label_mismatch",
    );
  }
}

function missingLabelKeys(
  labels: Readonly<Record<string, string>>,
  keys: readonly string[],
): string[] {
  return keys.filter((key) => labels[key] === undefined || labels[key]?.trim() === "");
}

/** Compose object の標準 provenance labels を resource kind ごとに conjunction 検証する。 */
export function validateComposeProvenance(
  labels: Readonly<Record<string, string>>,
  composeProject: string | undefined,
  kind: "container" | "network",
): void {
  const hasComposeLabel = COMPOSE_PROVENANCE_KEYS.some((key) => labels[key] !== undefined);
  if (!hasComposeLabel) {
    if (composeProject !== undefined) {
      throw new HostResourceAdapterError(
        "composeProject expectation に対応する Compose labels がありません",
        "label_mismatch",
      );
    }
    return;
  }

  const requiredKeys = kind === "container"
    ? COMPOSE_CONTAINER_PROVENANCE_KEYS
    : COMPOSE_NETWORK_PROVENANCE_KEYS;
  const missing = missingLabelKeys(labels, requiredKeys);
  if (missing.length > 0) {
    throw new HostResourceAdapterError(
      `Compose ${kind} provenance labels が不足しています: ${missing.join(", ")}`,
      "missing_labels",
    );
  }
  if (
    composeProject === undefined
    || composeProject.trim() === ""
    || labels[COMPOSE_LABELS.PROJECT] !== composeProject
  ) {
    throw new HostResourceAdapterError(
      "composeProject と Compose project label が一致しません",
      "label_mismatch",
    );
  }
  validateComposeLabelValues(labels);
}

/** actual labels が expected labels と完全一致するか conjunction で検証する。 */
export function verifyLabelsMatch(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): { matched: boolean; mismatches: readonly string[] } {
  const mismatches: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      mismatches.push(key);
    }
  }
  return { matched: mismatches.length === 0, mismatches };
}

/** Docker container/network ID が完全 ID（64 文字 hex）であることを検証する。 */
export function validateFullDockerIdFormat(id: string): void {
  if (!/^[\da-f]{64}$/i.test(id)) {
    throw new HostResourceAdapterError(
      `完全な Docker ID（64 文字 hex）が必要です。短縮 ID や名前は使用できません: ${id.slice(0, 16)}...`,
      "invalid_id",
    );
  }
}

/**
 * remove 時の expectedLabels が required Hachi labels を全て含み、
 * 用途/provenance の十分な conjunction を満たすことを検証する。
 * 空/部分ラベル + managed=true だけでは別 lease の managed object を削除できない。
 */
export function validateExpectedLabelsForRemoval(
  expectedLabels: Readonly<Record<string, string>>,
  resourceKind?: "container" | "network",
): void {
  const keys = Object.keys(expectedLabels);
  if (keys.length === 0) {
    throw new HostResourceAdapterError(
      "expectedLabels が空です。remove には required Hachi labels の完全な conjunction が必要です",
      "missing_labels",
    );
  }
  validateRequiredLabels(expectedLabels);
  const bundleKind = expectedLabels[HACHI_LABELS.BUNDLE_KIND];
  if (bundleKind === undefined || !REMOVABLE_BUNDLE_KINDS.has(bundleKind)) {
    throw new HostResourceAdapterError(
      `expectedLabels の ${HACHI_LABELS.BUNDLE_KIND} は削除可能な用途ではありません: ${bundleKind ?? ""}`,
      "label_mismatch",
    );
  }
  const hasComposeLabel = COMPOSE_PROVENANCE_KEYS.some(
    (key) => expectedLabels[key] !== undefined,
  );
  if (hasComposeLabel) {
    const allowedKeySets = resourceKind === "container"
      ? [COMPOSE_CONTAINER_PROVENANCE_KEYS]
      : resourceKind === "network"
        ? [COMPOSE_NETWORK_PROVENANCE_KEYS]
        : [COMPOSE_CONTAINER_PROVENANCE_KEYS, COMPOSE_NETWORK_PROVENANCE_KEYS];
    const hasRequiredConjunction = allowedKeySets.some(
      (keySet) => missingLabelKeys(expectedLabels, keySet).length === 0,
    );
    if (!hasRequiredConjunction) {
      throw new HostResourceAdapterError(
        `expectedLabels の Compose ${resourceKind ?? "resource"} provenance conjunction が不足しています`,
        "missing_labels",
      );
    }
    validateComposeLabelValues(expectedLabels);
  }
}

/** removal では Compose provenance expectation の省略も不一致として扱う。 */
export function verifyRemovalLabelsMatch(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): { matched: boolean; mismatches: readonly string[] } {
  const result = verifyLabelsMatch(actual, expected);
  const mismatches = [...result.mismatches];
  for (const key of COMPOSE_PROVENANCE_KEYS) {
    if (actual[key] !== undefined && expected[key] === undefined) {
      mismatches.push(key);
    }
  }
  return { matched: mismatches.length === 0, mismatches: [...new Set(mismatches)] };
}

/** port mapping が 127.0.0.1 のみで、wildcard bind でないことを検証する。 */
export function validatePortMapping(mapping: PortMapping): void {
  if (mapping.hostIp !== "127.0.0.1") {
    throw new HostResourceAdapterError(
      `ホスト IP は 127.0.0.1 のみ許可されます。wildcard bind は拒否されます: ${mapping.hostIp}`,
      "wildcard_bind",
    );
  }
  if (mapping.hostPort <= 0 || mapping.hostPort > 65535) {
    throw new HostResourceAdapterError(
      `無効なホストポート: ${String(mapping.hostPort)}`,
      "invalid_port",
    );
  }
}
