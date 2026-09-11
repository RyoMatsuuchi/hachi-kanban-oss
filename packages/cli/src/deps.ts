// =============================================================================
// CliDeps: 全コマンドが共有する依存関係の定義（テスト容易性のための DI コンテナ）
// main.ts は実環境用の CliDeps を組み立てて buildProgram(deps) に渡すだけの薄いエントリにする。
// テストでは temp home + :memory: store + ダミー adapter を注入する。
// =============================================================================

import type { BridgeIdentityResult } from "@hachi/adapters";
import { join } from "node:path";
import type {
  BridgeConfig,
  ExecutionCapabilitySnapshot,
  Environment,
  HachiConfig,
  HumanDecisionRequestStore,
  KanbanStore,
  NativeCommunicationAdapter,
  OrchestratorSuccessorLaunchStore,
  OrchestratorSuccessorFencedCloseStore,
  ProcessListProvider,
  Provider,
  WorkerAdapter,
  Transport,
} from "@hachi/core";
import type { RuntimeResourceInspector } from "./resource-inspector.js";
import type {
  ClaudeTrustProbe,
  HandoverDeliveryGateProbe,
} from "./orchestrator-handoff-delivery.js";
import type { OrchestratorHeartbeatLifecycle } from "./orchestrator-heartbeat-lifecycle.js";
import type { SuccessorAttestationArtifactResolver } from "./successor-attestation-artifacts.js";

export function resolveHermesHome(processEnv: NodeJS.ProcessEnv, osHome: string): string {
  const configured = processEnv.HERMES_HOME;
  return configured === undefined || configured === ""
    ? join(osHome, ".hermes-hachi-dev")
    : configured;
}

/** tmux の存在確認・セッション一覧取得の抽象。テストではスタブを注入する */
export interface TmuxProbe {
  /** tmux が PATH 上に存在するかを返す */
  available(): boolean;
  /** 既存の tmux セッション名一覧を返す（tmux 不在時は空配列） */
  listSessionNames(): string[];
}

/** tmux セッションの起動・生存確認の抽象。テストでは fake を注入して実 tmux を起こさない */
export interface TmuxLauncher {
  /** tmux new-session を detached で起動する。args は execFile へ渡す argv 配列 */
  launch(args: string[]): { ok: true; pid: number } | { ok: false; reason: string };
  /** tmux セッションが存在するか（has-session 相当） */
  hasSession(name: string): boolean;
  /** tmux pane のルートプロセス PID を返す。取得できなければ null */
  getPaneRootPid(name: string): number | null;
  /** tmux セッションを強制終了する（kill-session 相当）。ロールバックの fail-closed 補償に使う */
  killSession(sessionName: string): boolean;
  /** pane PID が属する process group id を返す。取得できなければ null（ロールバックの停止確認に使う） */
  getProcessGroupId(pid: number): number | null;
  /** 指定 process group に属するプロセスがまだ存在するか（true=生存）。ロールバックの停止確認に使う */
  isProcessGroupAlive(pgid: number): boolean;
  /**
   * session に所有権 nonce を紐付ける（set-option 相当）。launch 直後にのみ呼ぶ。成功したら true。
   * TOCTOU（preflight の名前重複チェック後に別プロセスが同名 session を作る）対策の要。
   */
  setSessionOwnerNonce(name: string, nonce: string): boolean;
  /** session に紐付いている所有権 nonce を返す（無ければ null）。ロールバック前に自分が作った session か確認する */
  getSessionOwnerNonce(name: string): string | null;
  /**
   * Codex successor の session 固定 readback。各 field の null は未観測を表し、
   * stable=false は tmux→ps→tmux の間に identity が変化したことを表す。
   */
  readSuccessorRuntime?(sessionName: string): SuccessorLaunchRuntimeReadback;
  /** runtime bind commit 後だけ、one-shot barrier を一度 signal する。 */
  releaseSuccessorBarrier?(barrier: string): boolean;
  /** exact pane PID の生存確認。successor rollback の hermetic test 用 DI。 */
  isPaneProcessAlive?(pid: number): boolean;
}

export interface SuccessorLaunchRuntimeReadback {
  stable: boolean;
  tmuxSession: string | null;
  tmuxPane: string | null;
  panePid: number | null;
  processGroupId: number | null;
  cwd: string | null;
  ownerNonce: string | null;
}

/** 15秒 attestation poll を実時間から切り離す hermetic clock。 */
export interface SuccessorLaunchClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

/** Codex SessionStart helper が読む標準入力。実機 stream と test fixture を差し替えるための抽象。 */
export interface CliStdinReader {
  /** UTF-8 byte 上限を越えた入力は途中で打ち切って throw する。 */
  read(maxBytes: number): Promise<string>;
}

/** exact pane から一度の安定した readback として得る runtime identity。 */
export interface SuccessorTmuxPaneReadback {
  tmuxSession: string;
  tmuxPane: string;
  panePid: number;
  processGroupId: number;
  cwd: string;
  ownerNonce: string;
  tmuxSocketPath: string;
  tmuxServerPid: number;
  tmuxServerStartTime: number;
  tmuxServerLifetimeHash: string;
}

export type SuccessorTmuxReadbackFailureReason = "missing" | "malformed" | "drift" | "unavailable";

export type SuccessorTmuxReadbackResult =
  | { ok: true; value: SuccessorTmuxPaneReadback }
  | { ok: false; reason: SuccessorTmuxReadbackFailureReason };

/**
 * locator である pane ID を authority に昇格させず、tmux 自身から全 identity を読み返す抽象。
 * bind producer だけが server lifetime を未設定時に初期化でき、attest/final は read-only 面だけを使う。
 */
export interface SuccessorTmuxReadback {
  readExactPane(tmuxPane: string): SuccessorTmuxReadbackResult;
  initializeServerLifetimeAndReadExactPane(
    tmuxPane: string,
    nonceCandidate: string,
  ): SuccessorTmuxReadbackResult;
}

export interface SuccessorAttestationArtifactHashes {
  hookDefinitionHash: string;
  hookExecutableHash: string;
}

/** install 済み静的 hook definition/helper の現在 hash を読む抽象。 */
export interface SuccessorAttestationHashProbe {
  readInstalledHashes(): SuccessorAttestationArtifactHashes;
}

/** 標準出力/標準エラー出力の抽象。process.stdout/stderr またはテスト用バッファを注入する */
export type CliWriteCallback = (error?: Error | null) => void;

export interface CliWriter {
  write(text: string, callback?: CliWriteCallback): void;
}

export type CliBridgeIdentityProbe = (bridge: BridgeConfig) => Promise<BridgeIdentityResult>;

export type CliBridgeListenerInspection =
  | { status: "not-listening" }
  | { status: "listening"; pid: number | null; detail?: string }
  | { status: "unknown"; detail: string };

export type CliBridgeListenerProbe = (bridge: BridgeConfig) => Promise<CliBridgeListenerInspection>;

export type CliModelTransportProbe = (
  provider: Provider,
  transport: Transport,
) => Promise<{ ok: true; snapshot: ExecutionCapabilitySnapshot } | { ok: false; detail: string }>;

/** hachi CLI の全コマンドが利用する依存関係 */
export interface CliDeps {
  /** DB への書き込みは必ずこの KanbanStore 経由（生 SQL 禁止 = 単一書込パスの原則） */
  store: KanbanStore & OrchestratorSuccessorLaunchStore & OrchestratorSuccessorFencedCloseStore &
    HumanDecisionRequestStore;
  config: HachiConfig;
  env: Environment;
  /** hermes wrapper が status を書く home。main で環境変数と OS home から解決して注入する。 */
  hermesHome: string;
  adapters: Record<Provider, WorkerAdapter>;
  /** same-provider native communication adapter。未構成はdoctorでreadiness不足として表示する。 */
  nativeCommunicationAdapters?: Partial<Record<Provider, NativeCommunicationAdapter>>;
  /** direct transport 用 adapter。direct run の停止・再投入で使う。 */
  directAdapters?: Partial<Record<Provider, WorkerAdapter>>;
  /** doctor の bridge 本人確認 probe。未指定時は実 bridge に GET /api/sessions する */
  bridgeIdentityProbe?: CliBridgeIdentityProbe;
  /** doctor の bridge LISTEN PID probe。未指定時は read-only の lsof を実行する。 */
  bridgeListenerProbe?: CliBridgeListenerProbe;
  /** doctor/admin resolve の read-only runtime capability probe。 */
  modelTransportProbe?: CliModelTransportProbe;
  /** doctor の worker process hygiene 走査。未指定時は ps を実行する */
  processListProvider?: ProcessListProvider;
  /** resource list/show/doctor の read-only host inspection。未指定時は CLI が実機 inspector を使う。 */
  runtimeResourceInspector?: RuntimeResourceInspector;
  /**
   * orchestrator usage が読むネイティブログのルート。未指定時は adapter と同じ規則
   * （CLAUDE_CONFIG_DIR / CODEX_HOME → ホーム配下）で解決する。テストが fixture を指すためだけの穴。
   */
  nativeUsageRoots?: { claudeProjectsRoot?: string; codexSessionsRoot?: string; codexAuthPath?: string };
  /**
   * doctor の「orchestrator helpers」検査が見る `~/.local/bin` 相当の bin dir。
   * 未指定時は OS home 配下の `.local/bin`。テストが実 host の `~/.local/bin` を
   * 触らずに済むための穴（t_eac0371a7a1a368e）。
   */
  orchestratorHelperBinDir?: string;
  /**
   * doctor の「orchestrator helpers」検査がシムの解決先を「repo内」と判定する基準repo root。
   * 未指定時は doctor.ts 自身の位置から算出する。テストが fixture repo を指すためだけの穴。
   */
  orchestratorHelperRepoRoot?: string;
  /** orchestrator handover の tmux 事前検査 probe。未指定時は実機の tmux を使う */
  tmuxProbe?: TmuxProbe;
  /** orchestrator handover の tmux 起動・生存確認。未指定時は実機の tmux を使う */
  tmuxLauncher?: TmuxLauncher;
  /** orchestrator handover --apply のロールバック時・停止確認 poll 設定。未指定時は本番デフォルト */
  handoverStopPoll?: { intervalMs: number; timeoutMs: number };
  /** orchestrator handover --apply の transcript 送達確認 poll 設定。未指定時は本番デフォルト */
  handoverDeliveryPoll?: { intervalMs: number; timeoutMs: number };
  /** handoff final 後に後継 heartbeat の進行を確認する poll 設定。未指定時は本番デフォルト */
  handoverSuccessorHeartbeatPoll?: { intervalMs: number; timeoutMs: number };
  /** detached heartbeat lifecycle。未指定時は実process/pidfile実装を使い、テストではfakeを注入する。 */
  orchestratorHeartbeatLifecycle?: OrchestratorHeartbeatLifecycle;
  /** 後継 transcript の user nonce / assistant 行を読む probe。テストでは fake を注入する */
  handoverDeliveryGateProbe?: HandoverDeliveryGateProbe;
  /** claude の cwd trust 承諾状態を読む probe。テストでは fake を注入する */
  claudeTrustProbe?: ClaudeTrustProbe;
  /** 後継セッション ID の採番。未指定時は randomUUID を使う。テストが名前衝突を確実に起こすための穴 */
  newSessionId?: () => string;
  /** argv と transcript の送達を結び付ける launch nonce の採番。テスト用 DI */
  newHandoffLaunchNonce?: () => string;
  /** Codex successor slot に hash だけを保存する launch nonce の採番。 */
  newSuccessorLaunchNonce?: () => string;
  /** tmux session へ設定し hash だけを保存する owner nonce の採番。 */
  newSuccessorOwnerNonce?: () => string;
  /** bind commit まで Codex 開始を止める one-shot barrier capability の採番。 */
  newSuccessorBarrierNonce?: () => string;
  /** bind producer が tmux server option の未設定時だけ使う256-bit nonce候補の採番。 */
  newSuccessorServerLifetimeNonce?: () => string;
  /**
   * handoff token 本体の採番。未指定時は newNonce()+newNonce() を使う。
   * dry-run と --apply で完全に同一の token 文字列を生成させ、
   * 「argv に載る token」と「hashToken → prepareOrchestratorHandoff に渡す token」の完全一致を
   * テストで検証するための DI 穴（`newSessionId` と同じパターン）。
   */
  newHandoffToken?: () => string;
  /** cwd が実在する directory かの判定。未指定時は実機の fs を見る */
  isDirectory?: (path: string) => boolean;
  /** SessionStart hook stdin。helper 以外のコマンドは読まない。 */
  stdin: CliStdinReader;
  /** helper が参照を許す process env。authority input は TMUX_PANE のみに限定する。 */
  processEnv: Readonly<NodeJS.ProcessEnv>;
  /** exact tmux pane readback。テストでは実 tmux を起動しない fake を注入する。 */
  successorTmuxReadback: SuccessorTmuxReadback;
  /** current host ID。テストで hostname に依存しないための DI。 */
  currentHostId: () => string;
  /** hook cwd/tmux cwd の canonical 化。テストで実 filesystem に依存しないための DI。 */
  canonicalizeSuccessorCwd: (path: string) => string;
  /** install 済み静的 hook definition/helper の exact hash probe。 */
  successorAttestationHashProbe: SuccessorAttestationHashProbe;
  /** production と doctor が共有する host publication artifact resolver。 */
  successorAttestationArtifactResolver?: SuccessorAttestationArtifactResolver;
  /** successor launch の15秒 bounded poll。未指定時は実時間を使う。 */
  successorLaunchClock?: SuccessorLaunchClock;
  /** successor rollback の三点停止 poll。未指定時は本番デフォルトを使う。 */
  successorLaunchStopPoll?: { intervalMs: number; timeoutMs: number };
  stdout: CliWriter;
  stderr: CliWriter;
  /** --debug 指定時にスタックトレースまで出力するかどうか */
  debug: boolean;
  /** プロセス終了処理。実環境では process.exitCode を設定し、テストでは記録のみ行う実装を注入する */
  exit: (code: number) => void;
}
