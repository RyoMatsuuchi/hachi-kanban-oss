// External runtime generation status の専用契約（docs/contract.md §75.7〜§75.13）。
// 凍結共有契約 types.ts へ型を追加せず、strict JSON/canonicalization/Store 面をこのモジュールに閉じ込める。
import { createHash } from "node:crypto";
import type { ExecutionRole, Provider, Transport } from "./types.js";

export const EXTERNAL_RUNTIME_GENERATION_SCHEMA = "external-runtime-generation-status/v1" as const;
export const EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH =
  "sha256:8b401504c7412dd865f97240995c4c38b59b7dbd8e813b88ccebf0f2c2f15208" as const;
export const EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS = 180_000;
export const EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS = 86_400_000;
export const EXTERNAL_RUNTIME_GENERATION_MAX_ATTESTATIONS = 32;
export const EXTERNAL_RUNTIME_GENERATION_MAX_TRANSITIONS = 256;
export const EXTERNAL_RUNTIME_GENERATION_MAX_FUTURE_MS = 5_000;
export const EXTERNAL_RUNTIME_GENERATION_CORRELATION_MS = 30_000;

export type ExternalRuntimeGenerationLane = "even-shared" | "even-claude";
export type ExternalRuntimeGenerationState = "running" | "stopped" | "replaced" | "unknown";

export interface ExternalRuntimeGenerationLaneSpec {
  provider: Provider;
  lane: ExternalRuntimeGenerationLane;
  runtimeKey: string;
  relativeStatusPath: string;
}

export const EXTERNAL_RUNTIME_GENERATION_LANES: Readonly<Record<Provider, ExternalRuntimeGenerationLaneSpec>> = {
  codex: {
    provider: "codex",
    lane: "even-shared",
    runtimeKey: "external-shared-runtime/codex/even-shared",
    relativeStatusPath: "even-shared/external-runtime-generation-status.json",
  },
  claude: {
    provider: "claude",
    lane: "even-claude",
    runtimeKey: "external-shared-runtime/claude/even-claude",
    relativeStatusPath: "even-claude/external-runtime-generation-status.json",
  },
};

export interface ExternalRuntimeGenerationIdentityV1 {
  kind: "external-shared-runtime";
  generationId: string;
  runtimeModelId: string;
  modelReadbackSource: "codex-applied-model" | "claude-runtime-model";
  writerPid: number;
  writerProcessStart: string;
  runtimePid: number;
  runtimeProcessStart: string;
  bootNonce: string;
  endpointIdentityHash: string;
  startedAt: number;
}

export interface ExternalRuntimeGenerationAttestationV1 {
  version: 1;
  schemaHash: typeof EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH;
  provider: Provider;
  lane: ExternalRuntimeGenerationLane;
  runtimeKey: string;
  statusRevision: number;
  state: "running";
  identity: ExternalRuntimeGenerationIdentityV1;
  observedAt: number;
  ttlMs: typeof EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS;
  expiresAt: number;
}

export interface ExternalRuntimeGenerationTransitionV1 {
  version: 1;
  revision: number;
  kind: ExternalRuntimeGenerationState;
  oldIdentity: ExternalRuntimeGenerationIdentityV1 | null;
  newIdentity: ExternalRuntimeGenerationIdentityV1 | null;
  lastSeenAt: number | null;
  stoppedAt: number | null;
  replacementFirstSeenAt: number | null;
  observedAt: number;
  ttlMs: typeof EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS;
  expiresAt: number;
  source: "owner-wait" | "host-supervisor" | "endpoint-observer";
}

export interface ExternalRuntimeGenerationStatusV1 {
  schema: typeof EXTERNAL_RUNTIME_GENERATION_SCHEMA;
  schemaVersion: 1;
  schemaHash: typeof EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH;
  provider: Provider;
  lane: ExternalRuntimeGenerationLane;
  runtimeKey: string;
  revision: number;
  state: ExternalRuntimeGenerationState;
  attestations: ExternalRuntimeGenerationAttestationV1[];
  transitions: ExternalRuntimeGenerationTransitionV1[];
  observedAt: number;
  ttlMs: typeof EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS;
  expiresAt: number;
}

export interface ValidatedExternalRuntimeGenerationStatus {
  status: ExternalRuntimeGenerationStatusV1;
  canonicalJson: string;
  canonicalDigest: string;
}

export type ExternalRuntimeGenerationValidationCode =
  | "json_invalid"
  | "duplicate_key"
  | "unknown_key"
  | "schema_invalid"
  | "value_invalid"
  | "array_order_invalid";

export class ExternalRuntimeGenerationValidationError extends Error {
  readonly code: ExternalRuntimeGenerationValidationCode;

  constructor(code: ExternalRuntimeGenerationValidationCode) {
    super(code);
    this.name = "ExternalRuntimeGenerationValidationError";
    this.code = code;
  }
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function validationError(code: ExternalRuntimeGenerationValidationCode): never {
  throw new ExternalRuntimeGenerationValidationError(code);
}

function assertUnicodeScalarString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      validationError("value_invalid");
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        validationError("value_invalid");
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      validationError("value_invalid");
    }
  }
  return value;
}

/** duplicate key と複数documentを見逃さない最小 strict JSON parser。 */
class StrictJsonParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): JsonValue {
    if (this.source.startsWith("\ufeff")) {
      validationError("json_invalid");
    }
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      validationError("json_invalid");
    }
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /[\u0009\u000a\u000d\u0020]/.test(this.source[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private parseValue(): JsonValue {
    const character = this.source[this.index];
    if (character === "{") return this.parseObject();
    if (character === "[") return this.parseArray();
    if (character === "\"") return this.parseString();
    if (this.source.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.source.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.source.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseObject(): { [key: string]: JsonValue } {
    this.index += 1;
    const value: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    const keys = new Set<string>();
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      if (this.source[this.index] !== "\"") validationError("json_invalid");
      const key = this.parseString();
      if (keys.has(key)) validationError("duplicate_key");
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") validationError("json_invalid");
      this.index += 1;
      this.skipWhitespace();
      value[key] = this.parseValue();
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "}") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") validationError("json_invalid");
      this.index += 1;
      this.skipWhitespace();
    }
    return validationError("json_invalid");
  }

  private parseArray(): JsonValue[] {
    this.index += 1;
    const value: JsonValue[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return value;
    }
    while (this.index < this.source.length) {
      value.push(this.parseValue());
      this.skipWhitespace();
      const delimiter = this.source[this.index];
      if (delimiter === "]") {
        this.index += 1;
        return value;
      }
      if (delimiter !== ",") validationError("json_invalid");
      this.index += 1;
      this.skipWhitespace();
    }
    return validationError("json_invalid");
  }

  private parseString(): string {
    this.index += 1;
    let result = "";
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === "\"") {
        this.index += 1;
        return assertUnicodeScalarString(result);
      }
      if (character === undefined || character.charCodeAt(0) <= 0x1f) {
        validationError("json_invalid");
      }
      if (character !== "\\") {
        result += character;
        this.index += 1;
        continue;
      }
      this.index += 1;
      const escape = this.source[this.index];
      this.index += 1;
      switch (escape) {
        case "\"": result += "\""; break;
        case "\\": result += "\\"; break;
        case "/": result += "/"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "n": result += "\n"; break;
        case "r": result += "\r"; break;
        case "t": result += "\t"; break;
        case "u": {
          const hex = this.source.slice(this.index, this.index + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) validationError("json_invalid");
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 4;
          break;
        }
        default:
          validationError("json_invalid");
      }
    }
    return validationError("json_invalid");
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (match === null) validationError("json_invalid");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) validationError("value_invalid");
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) validationError("schema_invalid");
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key))) validationError("unknown_key");
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    validationError("schema_invalid");
  }
  return value;
}

function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    validationError("value_invalid");
  }
  return value;
}

function positiveInteger(value: unknown): number {
  const normalized = safeInteger(value);
  if (normalized === 0) validationError("value_invalid");
  return normalized;
}

function exactExpiry(observedAt: number, ttlMs: number, expiresAt: number): void {
  if (!Number.isSafeInteger(observedAt + ttlMs) || expiresAt !== observedAt + ttlMs) {
    validationError("value_invalid");
  }
}

function literal<T extends string | number>(value: unknown, expected: T): T {
  if (value !== expected) validationError("schema_invalid");
  return expected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) validationError("schema_invalid");
  return value as T;
}

const IDENTITY_KEYS = [
  "kind", "generationId", "runtimeModelId", "modelReadbackSource", "writerPid",
  "writerProcessStart", "runtimePid", "runtimeProcessStart", "bootNonce",
  "endpointIdentityHash", "startedAt",
] as const;

export function validateExternalRuntimeGenerationIdentity(value: unknown): ExternalRuntimeGenerationIdentityV1 {
  const record = exactRecord(value, IDENTITY_KEYS);
  const generationId = typeof record["generationId"] === "string" ? record["generationId"] : "";
  const runtimeModelId = typeof record["runtimeModelId"] === "string" ? record["runtimeModelId"] : "";
  const writerProcessStart = typeof record["writerProcessStart"] === "string" ? record["writerProcessStart"] : "";
  const runtimeProcessStart = typeof record["runtimeProcessStart"] === "string" ? record["runtimeProcessStart"] : "";
  const bootNonce = typeof record["bootNonce"] === "string" ? record["bootNonce"] : "";
  const endpointIdentityHash = typeof record["endpointIdentityHash"] === "string"
    ? record["endpointIdentityHash"]
    : "";
  if (
    !/^[0-9a-f]{32}$/.test(generationId) ||
    !/^[A-Za-z0-9._:/@+-]{1,200}$/.test(runtimeModelId) ||
    !/^darwin-ps-lstart:[A-Za-z]{3} [A-Za-z]{3} {1,2}[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(
      writerProcessStart,
    ) ||
    !/^darwin-ps-lstart:[A-Za-z]{3} [A-Za-z]{3} {1,2}[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(
      runtimeProcessStart,
    ) ||
    !/^[0-9a-f]{32}$/.test(bootNonce) ||
    !/^sha256:[0-9a-f]{64}$/.test(endpointIdentityHash)
  ) {
    validationError("value_invalid");
  }
  return {
    kind: literal(record["kind"], "external-shared-runtime"),
    generationId,
    runtimeModelId,
    modelReadbackSource: oneOf(record["modelReadbackSource"], [
      "codex-applied-model", "claude-runtime-model",
    ] as const),
    writerPid: positiveInteger(record["writerPid"]),
    writerProcessStart,
    runtimePid: positiveInteger(record["runtimePid"]),
    runtimeProcessStart,
    bootNonce,
    endpointIdentityHash,
    startedAt: safeInteger(record["startedAt"]),
  };
}

function validateIdentityProvider(
  identity: ExternalRuntimeGenerationIdentityV1,
  provider: Provider,
): ExternalRuntimeGenerationIdentityV1 {
  const expectedSource = provider === "codex" ? "codex-applied-model" : "claude-runtime-model";
  if (
    identity.modelReadbackSource !== expectedSource ||
    (provider === "codex" && identity.writerPid === identity.runtimePid)
  ) validationError("value_invalid");
  return identity;
}

const ATTESTATION_KEYS = [
  "version", "schemaHash", "provider", "lane", "runtimeKey", "statusRevision", "state",
  "identity", "observedAt", "ttlMs", "expiresAt",
] as const;

export function validateExternalRuntimeGenerationAttestation(
  value: unknown,
  expectedProvider?: Provider,
): ExternalRuntimeGenerationAttestationV1 {
  const record = exactRecord(value, ATTESTATION_KEYS);
  const provider = oneOf(record["provider"], ["codex", "claude"] as const);
  const spec = EXTERNAL_RUNTIME_GENERATION_LANES[provider];
  if (expectedProvider !== undefined && provider !== expectedProvider) validationError("schema_invalid");
  const observedAt = safeInteger(record["observedAt"]);
  const expiresAt = safeInteger(record["expiresAt"]);
  const identity = validateIdentityProvider(
    validateExternalRuntimeGenerationIdentity(record["identity"]),
    provider,
  );
  exactExpiry(observedAt, EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS, expiresAt);
  if (identity.startedAt > observedAt) validationError("value_invalid");
  return {
    version: literal(record["version"], 1),
    schemaHash: literal(record["schemaHash"], EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH),
    provider,
    lane: literal(record["lane"], spec.lane),
    runtimeKey: literal(record["runtimeKey"], spec.runtimeKey),
    statusRevision: positiveInteger(record["statusRevision"]),
    state: literal(record["state"], "running"),
    identity,
    observedAt,
    ttlMs: literal(record["ttlMs"], EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS),
    expiresAt,
  };
}

const TRANSITION_KEYS = [
  "version", "revision", "kind", "oldIdentity", "newIdentity", "lastSeenAt", "stoppedAt",
  "replacementFirstSeenAt", "observedAt", "ttlMs", "expiresAt", "source",
] as const;

function nullableTime(value: unknown): number | null {
  return value === null ? null : safeInteger(value);
}

function timesAreOrdered(...values: Array<number | null>): boolean {
  let previous: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (previous !== null && previous > value) return false;
    previous = value;
  }
  return true;
}

function validateTransition(value: unknown): ExternalRuntimeGenerationTransitionV1 {
  const record = exactRecord(value, TRANSITION_KEYS);
  const kind = oneOf(record["kind"], ["running", "stopped", "replaced", "unknown"] as const);
  const oldIdentity = record["oldIdentity"] === null
    ? null
    : validateExternalRuntimeGenerationIdentity(record["oldIdentity"]);
  const newIdentity = record["newIdentity"] === null
    ? null
    : validateExternalRuntimeGenerationIdentity(record["newIdentity"]);
  const lastSeenAt = nullableTime(record["lastSeenAt"]);
  const stoppedAt = nullableTime(record["stoppedAt"]);
  const replacementFirstSeenAt = nullableTime(record["replacementFirstSeenAt"]);
  const observedAt = safeInteger(record["observedAt"]);
  const expiresAt = safeInteger(record["expiresAt"]);
  const source = oneOf(record["source"], ["owner-wait", "host-supervisor", "endpoint-observer"] as const);
  exactExpiry(observedAt, EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS, expiresAt);
  for (const identity of [oldIdentity, newIdentity]) {
    if (identity !== null && identity.startedAt > observedAt) validationError("value_invalid");
  }
  for (const time of [lastSeenAt, stoppedAt, replacementFirstSeenAt]) {
    if (time !== null && time > observedAt) validationError("value_invalid");
  }
  if (
    !timesAreOrdered(
      oldIdentity?.startedAt ?? null,
      lastSeenAt,
      newIdentity?.startedAt ?? null,
      replacementFirstSeenAt,
    ) ||
    !timesAreOrdered(oldIdentity?.startedAt ?? null, lastSeenAt, stoppedAt)
  ) validationError("value_invalid");
  if (kind === "running") {
    if (
      oldIdentity !== null || newIdentity === null || lastSeenAt !== null || stoppedAt !== null ||
      replacementFirstSeenAt !== null
    ) validationError("value_invalid");
  } else if (kind === "stopped") {
    if (
      oldIdentity === null || newIdentity !== null || lastSeenAt === null || stoppedAt === null ||
      replacementFirstSeenAt !== null || oldIdentity.startedAt > lastSeenAt || lastSeenAt > stoppedAt ||
      source === "endpoint-observer"
    ) validationError("value_invalid");
  } else if (kind === "replaced") {
    if (
      oldIdentity === null || newIdentity === null || lastSeenAt === null || stoppedAt !== null ||
      replacementFirstSeenAt === null || oldIdentity.startedAt > lastSeenAt ||
      lastSeenAt > newIdentity.startedAt || newIdentity.startedAt > replacementFirstSeenAt ||
      sameGenerationSubject(oldIdentity, newIdentity)
    ) validationError("value_invalid");
  } else {
    if (
      stoppedAt !== null ||
      (oldIdentity !== null && lastSeenAt !== null && oldIdentity.startedAt > lastSeenAt) ||
      (newIdentity !== null && replacementFirstSeenAt !== null && newIdentity.startedAt > replacementFirstSeenAt) ||
      (lastSeenAt !== null && replacementFirstSeenAt !== null && lastSeenAt > replacementFirstSeenAt)
    ) {
      validationError("value_invalid");
    }
  }
  return {
    version: literal(record["version"], 1),
    revision: positiveInteger(record["revision"]),
    kind,
    oldIdentity,
    newIdentity,
    lastSeenAt,
    stoppedAt,
    replacementFirstSeenAt,
    observedAt,
    ttlMs: literal(record["ttlMs"], EXTERNAL_RUNTIME_GENERATION_TRANSITION_TTL_MS),
    expiresAt,
    source,
  };
}

const STATUS_KEYS = [
  "schema", "schemaVersion", "schemaHash", "provider", "lane", "runtimeKey", "revision", "state",
  "attestations", "transitions", "observedAt", "ttlMs", "expiresAt",
] as const;

function compareCanonical(left: unknown, right: unknown): number {
  return Buffer.compare(Buffer.from(canonicalJson(left), "utf8"), Buffer.from(canonicalJson(right), "utf8"));
}

function transitionKey(transition: ExternalRuntimeGenerationTransitionV1): string {
  return canonicalJson([transition.kind, transition.oldIdentity, transition.newIdentity]);
}

function sameGenerationSubject(
  left: ExternalRuntimeGenerationIdentityV1,
  right: ExternalRuntimeGenerationIdentityV1,
): boolean {
  return left.generationId === right.generationId &&
    left.writerPid === right.writerPid &&
    left.writerProcessStart === right.writerProcessStart &&
    left.runtimePid === right.runtimePid &&
    left.runtimeProcessStart === right.runtimeProcessStart &&
    left.bootNonce === right.bootNonce &&
    left.endpointIdentityHash === right.endpointIdentityHash &&
    left.startedAt === right.startedAt;
}

function generationSubjectKey(identity: ExternalRuntimeGenerationIdentityV1): string {
  return canonicalJson({
    kind: identity.kind,
    generationId: identity.generationId,
    writerPid: identity.writerPid,
    writerProcessStart: identity.writerProcessStart,
    runtimePid: identity.runtimePid,
    runtimeProcessStart: identity.runtimeProcessStart,
    bootNonce: identity.bootNonce,
    endpointIdentityHash: identity.endpointIdentityHash,
    startedAt: identity.startedAt,
  });
}

export function validateExternalRuntimeGenerationStatus(
  value: unknown,
  expectedProvider?: Provider,
): ExternalRuntimeGenerationStatusV1 {
  const record = exactRecord(value, STATUS_KEYS);
  const provider = oneOf(record["provider"], ["codex", "claude"] as const);
  if (expectedProvider !== undefined && provider !== expectedProvider) validationError("schema_invalid");
  const spec = EXTERNAL_RUNTIME_GENERATION_LANES[provider];
  const revision = positiveInteger(record["revision"]);
  const state = oneOf(record["state"], ["running", "stopped", "replaced", "unknown"] as const);
  const observedAt = safeInteger(record["observedAt"]);
  const expiresAt = safeInteger(record["expiresAt"]);
  exactExpiry(observedAt, EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS, expiresAt);
  if (!Array.isArray(record["attestations"]) || record["attestations"].length > EXTERNAL_RUNTIME_GENERATION_MAX_ATTESTATIONS) {
    validationError("schema_invalid");
  }
  if (!Array.isArray(record["transitions"]) || record["transitions"].length > EXTERNAL_RUNTIME_GENERATION_MAX_TRANSITIONS) {
    validationError("schema_invalid");
  }
  const attestations = record["attestations"].map((attestation) =>
    validateExternalRuntimeGenerationAttestation(attestation, provider));
  const transitions = record["transitions"].map(validateTransition);
  const consumedIdentities = new Set<string>();
  const consumedGenerationRevisions = new Map<string, number>();
  const terminalBatches = new Map<number, {
    kind: Exclude<ExternalRuntimeGenerationState, "running">;
    anchor: string;
    oldSubject: ExternalRuntimeGenerationIdentityV1 | null;
    observation: string;
  }>();
  const runningBatchSubjects = new Map<number, ExternalRuntimeGenerationIdentityV1>();
  for (const transition of transitions) {
    if (transition.oldIdentity !== null) validateIdentityProvider(transition.oldIdentity, provider);
    if (transition.newIdentity !== null) validateIdentityProvider(transition.newIdentity, provider);
    if (transition.kind === "running") {
      const existingSubject = runningBatchSubjects.get(transition.revision);
      if (
        transition.newIdentity === null ||
        (existingSubject !== undefined && !sameGenerationSubject(existingSubject, transition.newIdentity))
      ) validationError("value_invalid");
      runningBatchSubjects.set(transition.revision, transition.newIdentity);
      continue;
    }
    const batch = terminalBatches.get(transition.revision);
    const anchor = canonicalJson(transition.newIdentity);
    const observation = canonicalJson([
      transition.lastSeenAt,
      transition.stoppedAt,
      transition.replacementFirstSeenAt,
      transition.observedAt,
      transition.source,
    ]);
    if (batch === undefined) {
      terminalBatches.set(transition.revision, {
        kind: transition.kind,
        anchor,
        oldSubject: transition.oldIdentity,
        observation,
      });
    } else {
      if (batch.kind !== transition.kind || batch.anchor !== anchor || batch.observation !== observation) {
        validationError("value_invalid");
      }
      if (
        (batch.oldSubject === null) !== (transition.oldIdentity === null) ||
        (batch.oldSubject !== null && transition.oldIdentity !== null &&
          !sameGenerationSubject(batch.oldSubject, transition.oldIdentity))
      ) validationError("value_invalid");
    }
    if (transition.oldIdentity !== null) {
      const oldIdentity = canonicalJson(transition.oldIdentity);
      if (consumedIdentities.has(oldIdentity)) validationError("value_invalid");
      consumedIdentities.add(oldIdentity);
      const subjectKey = generationSubjectKey(transition.oldIdentity);
      const subjectRevision = consumedGenerationRevisions.get(subjectKey);
      if (subjectRevision !== undefined && subjectRevision !== transition.revision) {
        validationError("value_invalid");
      }
      consumedGenerationRevisions.set(subjectKey, transition.revision);
    }
  }
  for (let index = 0; index < attestations.length; index += 1) {
    const current = attestations[index]!;
    if (
      current.statusRevision > revision || current.observedAt > observedAt ||
      consumedIdentities.has(canonicalJson(current.identity))
    ) validationError("value_invalid");
    if (index > 0) {
      const previous = attestations[index - 1]!;
      if (compareCanonical(previous.identity, current.identity) >= 0) validationError("array_order_invalid");
      if (!sameGenerationSubject(previous.identity, current.identity)) validationError("value_invalid");
      if (previous.identity.runtimeModelId === current.identity.runtimeModelId) validationError("value_invalid");
    }
  }
  const attestationsByRevision = [...attestations].sort((left, right) => left.statusRevision - right.statusRevision);
  for (let index = 1; index < attestationsByRevision.length; index += 1) {
    const previous = attestationsByRevision[index - 1]!;
    const current = attestationsByRevision[index]!;
    if (
      previous.observedAt > current.observedAt ||
      (previous.statusRevision === current.statusRevision && previous.observedAt !== current.observedAt)
    ) validationError("value_invalid");
  }
  for (let index = 0; index < transitions.length; index += 1) {
    const current = transitions[index]!;
    if (current.revision > revision || current.observedAt > observedAt) validationError("value_invalid");
    if (index > 0) {
      const previous = transitions[index - 1]!;
      if (previous.revision > current.revision) validationError("array_order_invalid");
      if (
        previous.revision === current.revision &&
        Buffer.compare(Buffer.from(transitionKey(previous)), Buffer.from(transitionKey(current))) >= 0
      ) validationError("array_order_invalid");
      if (previous.revision === current.revision && previous.kind !== current.kind) {
        validationError("value_invalid");
      }
      if (
        previous.observedAt > current.observedAt ||
        (previous.revision === current.revision && previous.observedAt !== current.observedAt)
      ) validationError("value_invalid");
    }
  }
  if (transitions.length === 0 || transitions.at(-1)!.kind !== state) validationError("value_invalid");
  if (state === "running" && attestations.length === 0) validationError("value_invalid");
  if (state !== "running") {
    if (attestations.length !== 0) validationError("value_invalid");
    const batch = transitions.filter((transition) => transition.revision === revision);
    if (batch.length === 0 || batch.some((transition) => transition.kind !== state)) {
      validationError("value_invalid");
    }
    if (batch.some((transition) => transition.observedAt !== observedAt)) validationError("value_invalid");
  }
  return {
    schema: literal(record["schema"], EXTERNAL_RUNTIME_GENERATION_SCHEMA),
    schemaVersion: literal(record["schemaVersion"], 1),
    schemaHash: literal(record["schemaHash"], EXTERNAL_RUNTIME_GENERATION_SCHEMA_HASH),
    provider,
    lane: literal(record["lane"], spec.lane),
    runtimeKey: literal(record["runtimeKey"], spec.runtimeKey),
    revision,
    state,
    attestations,
    transitions,
    observedAt,
    ttlMs: literal(record["ttlMs"], EXTERNAL_RUNTIME_GENERATION_STATUS_TTL_MS),
    expiresAt,
  };
}

/** validated value を §75.11 の canonical JSON へ再encodeする。 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) validationError("value_invalid");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(assertUnicodeScalarString(value));
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!isRecord(value)) validationError("value_invalid");
  const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  return `{${keys.map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function externalRuntimeGenerationDigest(canonicalPayload: string): string {
  return `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`;
}

/** consumer-visible bridge originからcredentialを含まないendpoint identityを作る。 */
export function externalRuntimeGenerationEndpointIdentityHash(provider: Provider, origin: string): string {
  const spec = EXTERNAL_RUNTIME_GENERATION_LANES[provider];
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return validationError("value_invalid");
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (
    (scheme !== "http" && scheme !== "https") || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" || url.pathname !== "/" || url.hostname === ""
  ) validationError("value_invalid");
  const port = url.port === "" ? (scheme === "http" ? "80" : "443") : url.port;
  if (!/^(?:0|[1-9][0-9]*)$/.test(port) || Number(port) > 65_535 || Number(port) === 0) {
    validationError("value_invalid");
  }
  const canonical = `external-shared-runtime/v1\u0000${provider}\u0000${spec.lane}\u0000${scheme}` +
    `\u0000${url.hostname}\u0000${port}`;
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function parseExternalRuntimeGenerationStatus(
  source: string,
  expectedProvider?: Provider,
): ValidatedExternalRuntimeGenerationStatus {
  const rawValue = new StrictJsonParser(source).parse();
  const status = validateExternalRuntimeGenerationStatus(rawValue, expectedProvider);
  const canonicalPayload = canonicalJson(status);
  return {
    status,
    canonicalJson: canonicalPayload,
    canonicalDigest: externalRuntimeGenerationDigest(canonicalPayload),
  };
}

export function externalRuntimeGenerationStatusIsFresh(
  status: Pick<ExternalRuntimeGenerationStatusV1, "observedAt" | "expiresAt">,
  nowMs: number,
): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 &&
    status.observedAt <= nowMs + EXTERNAL_RUNTIME_GENERATION_MAX_FUTURE_MS &&
    nowMs <= status.expiresAt;
}

export function externalRuntimeGenerationAttestationIsFresh(
  attestation: Pick<ExternalRuntimeGenerationAttestationV1, "observedAt" | "expiresAt">,
  nowMs: number,
): boolean {
  return externalRuntimeGenerationStatusIsFresh(attestation, nowMs);
}

export interface ExternalRuntimeGenerationStatusRecord extends ValidatedExternalRuntimeGenerationStatus {
  acceptedAt: number;
}

export interface ExternalRuntimeGenerationBindingV1 {
  version: 1;
  taskId: string;
  runId: number;
  sessionId: string;
  role: ExecutionRole;
  provider: Provider;
  transport: Transport;
  runtimeKey: string;
  identity: ExternalRuntimeGenerationIdentityV1;
  boundAt: number;
}

export type ExternalRuntimeGenerationStatusAcceptance =
  | "accepted"
  | "idempotent"
  | "replay"
  | "equivocation"
  | "history_missing";

export interface BindExternalRuntimeGenerationLaunchInput {
  taskId: string;
  runId: number;
  sessionId: string;
  role: ExecutionRole;
  provider: Provider;
  transport: Transport;
  attestation: unknown;
  statusRevision: number;
  statusDigest: string;
  boundAt: number;
}

export interface ExternalRuntimeGenerationStore {
  acceptExternalRuntimeGenerationStatus(
    sample: ValidatedExternalRuntimeGenerationStatus,
    acceptedAt: number,
  ): ExternalRuntimeGenerationStatusAcceptance;
  bindExternalRuntimeGenerationLaunch(input: BindExternalRuntimeGenerationLaunchInput): boolean;
  getExternalRuntimeGenerationStatus(provider: Provider): ExternalRuntimeGenerationStatusRecord | null;
  getExternalRuntimeGenerationBinding(runId: number): ExternalRuntimeGenerationBindingV1 | null;
  listExternalRuntimeGenerationBindingsByIdentity(
    provider: Provider,
    runtimeKey: string,
    identity: ExternalRuntimeGenerationIdentityV1,
  ): ExternalRuntimeGenerationBindingV1[];
}

export interface ExternalRuntimeGenerationReadView {
  externalRuntimeGenerationStatus(provider: Provider): ExternalRuntimeGenerationStatusRecord | null;
  externalRuntimeGenerationBinding(runId: number): ExternalRuntimeGenerationBindingV1 | null;
}

export function isExternalRuntimeGenerationStore(value: unknown): value is ExternalRuntimeGenerationStore {
  return isRecord(value) &&
    typeof value["acceptExternalRuntimeGenerationStatus"] === "function" &&
    typeof value["bindExternalRuntimeGenerationLaunch"] === "function" &&
    typeof value["getExternalRuntimeGenerationStatus"] === "function" &&
    typeof value["getExternalRuntimeGenerationBinding"] === "function";
}

export interface RuntimeGenerationInterruptionCorrelationV1 {
  version: 1;
  reason: "runtime_generation_interrupted";
  taskId: string;
  runId: number;
  sessionId: string;
  role: ExecutionRole;
  provider: Provider;
  transport: Transport;
  runtimeKey: string;
  generationId: string;
  transitionKind: "stopped" | "replaced";
  terminalObservedAt: number;
  transitionObservedAt: number;
  deltaMs: number;
  diagnosticCode: "worker_output_missing" | "runtime_transport_closed";
  correlatedRunIds: number[];
}

export interface ClassifyRuntimeGenerationInterruptionInput {
  binding: ExternalRuntimeGenerationBindingV1;
  status: ExternalRuntimeGenerationStatusRecord;
  runStartedAt: number;
  terminalObservedAt: number;
  nowMs: number;
  diagnosticCode: "worker_output_missing" | "runtime_transport_closed";
  correlatedRunIds?: number[];
}

function distanceFromInterval(point: number, start: number, end: number): number {
  if (point < start) return start - point;
  if (point > end) return point - end;
  return 0;
}

/** §75.3 の conjunction を満たす terminal transition だけを confirmed へ投影する。 */
export function classifyRuntimeGenerationInterruption(
  input: ClassifyRuntimeGenerationInterruptionInput,
): RuntimeGenerationInterruptionCorrelationV1 | null {
  const { binding, status } = input;
  if (
    status.status.provider !== binding.provider || status.status.runtimeKey !== binding.runtimeKey ||
    !Number.isSafeInteger(input.runStartedAt) || !Number.isSafeInteger(input.terminalObservedAt) ||
    !Number.isSafeInteger(input.nowMs) || input.runStartedAt < 0 || input.terminalObservedAt < input.runStartedAt
  ) return null;
  const identityJson = canonicalJson(binding.identity);
  for (const transition of status.status.transitions) {
    if (
      (transition.kind !== "stopped" && transition.kind !== "replaced") ||
      transition.oldIdentity === null || canonicalJson(transition.oldIdentity) !== identityJson ||
      input.nowMs > transition.expiresAt ||
      (transition.kind === "stopped" && transition.source === "endpoint-observer")
    ) continue;
    const intervalStart = transition.kind === "stopped" ? transition.stoppedAt : transition.lastSeenAt;
    const intervalEnd = transition.kind === "stopped" ? transition.stoppedAt : transition.replacementFirstSeenAt;
    if (intervalStart === null || intervalEnd === null) continue;
    const intersectsRun = intervalEnd >= input.runStartedAt && intervalStart <= input.terminalObservedAt;
    const deltaMs = distanceFromInterval(input.terminalObservedAt, intervalStart, intervalEnd);
    if (!intersectsRun || deltaMs > EXTERNAL_RUNTIME_GENERATION_CORRELATION_MS) continue;
    const transitionObservedAt = transition.kind === "stopped" ? transition.stoppedAt : transition.replacementFirstSeenAt;
    if (transitionObservedAt === null) continue;
    return {
      version: 1,
      reason: "runtime_generation_interrupted",
      taskId: binding.taskId,
      runId: binding.runId,
      sessionId: binding.sessionId,
      role: binding.role,
      provider: binding.provider,
      transport: binding.transport,
      runtimeKey: binding.runtimeKey,
      generationId: binding.identity.generationId,
      transitionKind: transition.kind,
      terminalObservedAt: input.terminalObservedAt,
      transitionObservedAt,
      deltaMs,
      diagnosticCode: input.diagnosticCode,
      correlatedRunIds: [...new Set(input.correlatedRunIds ?? [])].sort((left, right) => left - right),
    };
  }
  return null;
}
