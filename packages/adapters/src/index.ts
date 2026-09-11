// @hachi/adapters 公開エントリポイント
export {
  BridgeError,
  bridgeFetch,
  bridgeHealthCheck,
  probeBridgeCapabilities,
  probeBridgeExecutionCapabilities,
  probeBridgeIdentity,
  readBridgeToken,
} from "./http.js";
export type {
  BridgeCapabilitiesFailure,
  BridgeCapabilitiesFailureKind,
  BridgeCapabilitiesResult,
  BridgeExecutionCapabilityDeps,
  BridgeExecutionCapabilityResult,
  BridgeErrorKind,
  BridgeFetchInit,
  BridgeIdentityDeps,
  BridgeIdentityFailure,
  BridgeIdentityFailureKind,
  BridgeIdentityFetchFn,
  BridgeIdentityResult,
  BridgeRetryDeps,
  SleepFn,
} from "./http.js";
export { CodexAdapter } from "./codex.js";
export type { CodexAdapterOptions } from "./codex.js";
export { CLAUDE_BRIDGE_MAX_TURNS, ClaudeAdapter } from "./claude.js";
export type { ClaudeAdapterOptions } from "./claude.js";
export {
  ExactSessionStopFacade,
  FakeExactSessionStopTransport,
  SESSION_STOP_V1_CAPABILITY,
  probeSessionStopCapability,
} from "./session-stop.js";
export type {
  ExactSessionStopTransport,
  ExactSessionStopTransportRequest,
  FakeSessionStopMode,
  FakeSessionStopRegistration,
  SessionStopCapabilityProbeDeps,
} from "./session-stop.js";
export {
  fetchSessionMessages,
  fetchSessionsByCwdAndProvider,
  injectSession,
  launchSession,
  parseWorkerApiErrorObservation,
} from "./session.js";
export type {
  BridgeLaunchOptions,
  BridgeLaunchSessionRef,
  BridgePassthroughRequest,
  BridgeSessionCandidate,
  BridgeSessionStatus,
  SessionMessages,
  WorkerApiErrorCategory,
  WorkerApiErrorObservationEntry,
  WorkerApiErrorObservationInvalidReason,
  WorkerApiErrorObservationParseResult,
  WorkerApiErrorObservationV1,
} from "./session.js";
// direct session の生存判定/state 読み取り（supervisor の stall 検知が stop 経路と同じ根拠を使うため）
export { isProcessAlive, isProcessGroupAlive, readDirectOutHead, readDirectSessionState } from "./direct-process.js";
export type { DirectSessionState } from "./direct-process.js";
export { DirectCodexAdapter, resolveCodexSessionsRoot } from "./direct-codex.js";
export type { DirectCodexAdapterOptions } from "./direct-codex.js";
export { DirectClaudeAdapter, resolveClaudeProjectsRoot } from "./direct-claude.js";
export type { DirectClaudeAdapterOptions } from "./direct-claude.js";
// ネイティブログの読み取り。direct run の usage 収集とオーケストレーターの自己計測が同じ parser を使う。
export {
  collectClaudeNativeUsage,
  collectCodexNativeUsage,
  findClaudeSessionDir,
  findCodexRollout,
  isPathWithinRoot,
  isValidNativeSessionId,
  NATIVE_SESSION_ID_PATTERN,
  parseCodexSessionId,
} from "./native-usage.js";
export type { ClaudeNativeUsageInput, CodexNativeUsageInput } from "./native-usage.js";
export {
  CodexAppServerAdapter,
  CodexAppServerCommunicationAdapter,
  CodexAppServerNativeAdapter,
  CodexAppServerWorkerAdapter,
} from "./codex-app-server.js";
export type {
  CodexAppServerAdapterOptions,
  CodexAppServerThreadReadResult,
} from "./codex-app-server.js";
export {
  CodexAppServerClient,
  CodexAppServerError,
  CodexAppServerRpcClient,
  codexAppServerSocketSnapshotsEqual,
  codexAppServerSupervisorDetail,
} from "./codex-app-server-rpc.js";
export type {
  CodexAppServerClientInfo,
  CodexAppServerErrorKind,
  CodexAppServerInitializeInfo,
  CodexAppServerMethod,
  CodexAppServerNotification,
  CodexAppServerRequestId,
  CodexAppServerRpcClientOptions,
  CodexAppServerSocketSnapshot,
  CodexAppServerSupervisorErrorCode,
} from "./codex-app-server-rpc.js";
export {
  CODEX_APP_SERVER_CLI_VERSION,
  CODEX_APP_SERVER_GENERATED_SCHEMA_SHA256,
  CODEX_APP_SERVER_METHODS,
  CODEX_APP_SERVER_SCHEMA_CHECKSUM,
  CODEX_APP_SERVER_SCHEMA_FIXTURE_SHA256,
  CODEX_APP_SERVER_SCHEMA_FIXTURE,
  CODEX_APP_SERVER_SCHEMA_PIN,
  CODEX_APP_SERVER_SCHEMA_SHA256,
  CODEX_APP_SERVER_SCHEMA_SOURCE,
  CODEX_APP_SERVER_SCHEMA_VERSION,
} from "./schema/codex-app-server-v2.js";
export type {
  CodexAppServerMethod as CodexAppServerSchemaMethod,
  CodexAppServerSchemaPin,
} from "./schema/codex-app-server-v2.js";
export { buildInProgressReason, parseSessionIdFromReason } from "./reason.js";
export { FakeRuntimeResourceDiscovery } from "./runtime-resource-discovery.js";
export type {
  RuntimeDiscoverySource,
  RuntimeResourceDiscovery,
  RuntimeResourceLookup,
  RuntimeResourceObservation,
} from "./runtime-resource-discovery.js";
export {
  FakeHostResourceAdapter,
} from "./host-resource-adapter-fake.js";
export {
  DockerHostResourceAdapter,
} from "./docker-host-resource-adapter.js";
export type {
  CommandRunner,
  CommandRunnerOptions,
  CommandRunnerResult,
  DockerHealthSleep,
  DockerHostResourceAdapterOptions,
} from "./docker-host-resource-adapter.js";
export {
  COMPOSE_LABELS,
  HACHI_LABELS,
  HostResourceAdapterError,
  REQUIRED_HACHI_LABEL_KEYS,
  validateExpectedLabelsForRemoval,
  validateComposeProvenance,
  validateFullDockerIdFormat,
  validatePortMapping,
  validateRequiredLabels,
  verifyLabelsMatch,
  verifyRemovalLabelsMatch,
} from "./host-resource-adapter.js";
export {
  DIRECT_SPEED_CONTROL_CAPABILITY,
  probeDirectRuntimeCapabilities,
  SystemDirectRuntimeCapabilityRunner,
} from "./direct-runtime-capabilities.js";
export type {
  DirectRuntimeCapabilityProbeOptions,
  DirectRuntimeCapabilityProbeResult,
  DirectRuntimeCapabilityRunner,
  DirectRuntimeCommandRequest,
  DirectRuntimeCommandResult,
} from "./direct-runtime-capabilities.js";
export type {
  ContainerInspection,
  CreatedHostResource,
  HealthCheckConfig,
  HostResourceAdapter,
  HostResourceOperationOptions,
  NetworkInspection,
  PortMapping,
  ProvisionContainerParams,
  ProvisionContainerResult,
  ProvisionNetworkParams,
  ProvisionNetworkResult,
  ReadonlyBindMount,
  RemoveContainerParams,
  RemoveNetworkParams,
  RemoveResult,
  RemoveResultStatus,
} from "./host-resource-adapter.js";
export {
  CLAUDE_HOOK_ENABLE_RECORD_MAX_BYTES,
  CLAUDE_HOOK_TEXT_MAX_BYTES,
  CLAUDE_HOOK_TOOL_PAYLOAD_MAX_BYTES,
  CLAUDE_HOOK_TOOL_SUMMARY_MAX_BYTES,
  ClaudeHookRelayAdapter,
  DEFAULT_CLAUDE_HOOK_RELAY_TIMEOUT_MS,
  createClaudeHookRelaySettings,
  parseClaudeHookEnableRecord,
  readClaudeHookEnableRecord,
} from "./claude-hook-relay-adapter.js";
export type {
  ClaudeHookEnableRecord,
  ClaudeHookIgnoredReason,
  ClaudeHookRelayAction,
  ClaudeHookRelayAdapterOptions,
  ClaudeHookRelayEmitter,
  ClaudeHookRelayOutcome,
  ClaudeHookRelaySettings,
} from "./claude-hook-relay-adapter.js";

export {
  CLAUDE_CROSS_SESSION_INBOUND_CAPABILITY,
  CLAUDE_CROSS_SESSION_MIN_RUNTIME_VERSION,
  CLAUDE_RELAY_ENVELOPE_SCHEMA,
  CLAUDE_RELAY_RECEIPT_SCHEMA,
  ClaudeCrossSessionAdapter,
  ClaudeCrossSessionCommunicationAdapter,
  ClaudeCrossSessionNativeAdapter,
  ClaudeCrossSessionRelayAdapter,
  ClaudeCrossSessionWorkerAdapter,
  assertClaudeRelayReceipt,
  buildClaudeRelayEnvelope,
  buildClaudeRelayPrompt,
  computeClaudeCrossSessionCapabilityHash,
  createClaudeRelayEnvelope,
  parseClaudeAgentsJson,
  parseClaudeRelayReceipt,
  parseClaudeRuntimeVersion,
} from "./claude-cross-session.js";
export type {
  ClaudeAgentEntry,
  ClaudeAgentList,
  ClaudeCrossSessionCommandResult,
  ClaudeCrossSessionCommandRunner,
  ClaudeCrossSessionSpawnRequest,
  ClaudeCrossSessionSpawnResult,
  ClaudeCrossSessionSpawner,
  ClaudeCrossSessionWorkerOptions,
  ClaudeRelayAckCommand,
  ClaudeRelayEnvelope,
  ClaudeRelayExecutor,
  ClaudeRelayReceipt,
  ClaudeRelayReceiptExpectation,
  ClaudeRelayReceiptOutcome,
  ClaudeRelayReceiptParseResult,
  ClaudeRelaySourcePrincipal,
  ClaudeRelayTarget,
} from "./claude-cross-session.js";
export {
  CLAUDE_STOP_HOOK_SCHEMA,
  CLAUDE_STOP_HOOK_SCRIPT_SUFFIX,
  CLAUDE_STOP_MAX_HOOK_INPUT_BYTES,
  CLAUDE_STOP_MAX_LAST_MESSAGE_BYTES,
  CLAUDE_STOP_MAX_TRANSCRIPT_BYTES,
  CLAUDE_STOP_RESULT_SUFFIX,
  CLAUDE_STOP_TRANSCRIPT_SUFFIX,
  buildClaudeStopHookSettings,
  captureClaudeStopHookInput,
  claudeTranscriptHookPaths,
  installClaudeTranscriptHook,
  readClaudeTranscriptCapture,
  renderClaudeStopHookScript,
} from "./claude-transcript-hook.js";
export type {
  ClaudeStopCaptureResult,
  ClaudeStopHookInput,
  ClaudeStopHookSettings,
  ClaudeStopResultArtifact,
  ClaudeTranscriptHookPaths,
} from "./claude-transcript-hook.js";
