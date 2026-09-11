// provider のネイティブセッションログから token usage を読み取る（設計 R1〜R3）。
//
// なぜ CLI の構造化出力ではなくログを読むのか:
//   `.out` は supervisor の fence-extraction が生テキスト前提で走査する唯一の transcript 面であり、
//   `codex exec --json` / `claude --output-format json` へ切り替えると handoff fence が JSON 文字列へ
//   エスケープされて全 direct run の handoff 抽出が静かに壊れる（設計 §5.3）。
//   そこで `.out` には一切触れず、CLI が副作用として必ず書くネイティブログを事後読み取りする。
//
// 相関は時刻ウィンドウ推測に依存しない（設計 R3）:
//   claude は `--session-id <uuid>` で run と 1:1 の uuid を渡し、その uuid のファイルだけを読む。
//   codex は `--session-id` 相当を持たないため、codex 自身が `.out` 冒頭へ出力する
//   `session id: <uuid>` を読み、その uuid を**ファイル名で完全一致**させて rollout を特定する。
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import {
  executionKey,
  parseEffortLevel,
  type EffortLevel,
  type ExecutionTokenUsage,
  type MainSessionTurn,
  type MainSessionUsage,
  type ModelTokenUsage,
  type NativeUsageObservation,
  type Provider,
  type UsageUnavailableReason,
} from "@hachi/core";

/**
 * 1ファイルあたりの読み取り上限。ネイティブログは 700MB を超える実例があり（本機の codex rollout 最大
 * 779MB）、finalize を数十秒ブロックしうる。上限超過は 0 を書かず log-unreadable（=unknown）にする。
 */
const MAX_LOG_BYTES = 256 * 1024 * 1024;

/** 観測できなかったことを表す戻り値のショートハンド。 */
function unavailable(reason: UsageUnavailableReason): NativeUsageObservation {
  return { observed: false, reason };
}

/** JSONL を1行ずつ読む。全文をメモリに載せない（巨大ログ対策）。 */
async function* readJsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line.length === 0) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 途中で切れた行（書き込み中のクラッシュ等）は捨てる。1行の破損で全体を失わない。
        continue;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        yield parsed as Record<string, unknown>;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
}

/** ファイルが読める通常ファイルで、上限バイト以内かを判定する。 */
async function readableLogSize(path: string): Promise<"ok" | "too-large" | "missing"> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return "missing";
    }
    return info.size > MAX_LOG_BYTES ? "too-large" : "ok";
  } catch {
    return "missing";
  }
}

/** ネストした値を安全に取り出す小道具（allowlist 抽出のため any は使わない）。 */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/** 存在する非負整数だけを返す。未報告と実測 0 を区別する内数向け。 */
function optionalNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

/** 正の数値だけ受理する。無い/不正なら undefined（0 埋めしない）。 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochMs(value: unknown): number | null {
  const raw = text(value);
  if (raw === null) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** 加算器の内部状態。1h 内訳は「provider が報告しない」を undefined で表す（0 と区別する）。 */
interface AccumulatedTokens {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** outputTokens の内数。報告のない provider では undefined */
  reasoningOutputTokens: number | undefined;
  /** cacheCreationTokens の**内数**のうち 1h TTL 分。報告のない provider（codex）では undefined */
  cacheCreation1hTokens: number | undefined;
}

/** モデル別トークンの加算器。model は launch 時の model ではなくログ上の実測モデルを使う。 */
class ModelTokenAccumulator {
  private readonly byModel = new Map<string, AccumulatedTokens>();

  add(
    model: string,
    delta: Omit<AccumulatedTokens, "cacheCreation1hTokens" | "reasoningOutputTokens"> & {
      cacheCreation1hTokens?: number;
      reasoningOutputTokens?: number;
    },
  ): void {
    const current = this.byModel.get(model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningOutputTokens: undefined,
      cacheCreation1hTokens: undefined,
    };
    current.inputTokens += delta.inputTokens;
    current.outputTokens += delta.outputTokens;
    current.cacheCreationTokens += delta.cacheCreationTokens;
    current.cacheReadTokens += delta.cacheReadTokens;
    if (delta.reasoningOutputTokens !== undefined) {
      current.reasoningOutputTokens = (current.reasoningOutputTokens ?? 0) + delta.reasoningOutputTokens;
    }
    if (delta.cacheCreation1hTokens !== undefined) {
      current.cacheCreation1hTokens = (current.cacheCreation1hTokens ?? 0) + delta.cacheCreation1hTokens;
    }
    this.byModel.set(model, current);
  }

  get size(): number {
    return this.byModel.size;
  }

  toArray(): ModelTokenUsage[] {
    return [...this.byModel.entries()]
      .map(([model, t]) => ({
        model,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
        cacheCreationTokens: t.cacheCreationTokens,
        cacheReadTokens: t.cacheReadTokens,
        ...(t.reasoningOutputTokens !== undefined ? { reasoningOutputTokens: t.reasoningOutputTokens } : {}),
        // 報告のない provider ではキーごと省略する（exactOptionalPropertyTypes）。
        ...(t.cacheCreation1hTokens !== undefined ? { cacheCreation1hTokens: t.cacheCreation1hTokens } : {}),
      }))
      .sort((a, b) => a.model.localeCompare(b.model));
  }
}

/** provider / model / effort の三つ組別に main-chain の消費を積む。 */
class ExecutionTokenAccumulator {
  private readonly byExecution = new Map<string, ExecutionTokenUsage>();

  addTurn(provider: Provider, effort: EffortLevel | null, entries: readonly ModelTokenUsage[]): void {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (isZeroTokens(entry)) {
        continue;
      }
      const identity = { provider, model: entry.model, effort };
      const key = executionKey(identity);
      const current = this.byExecution.get(key) ?? {
        ...identity,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      };
      current.inputTokens += entry.inputTokens;
      current.outputTokens += entry.outputTokens;
      current.cacheCreationTokens += entry.cacheCreationTokens;
      current.cacheReadTokens += entry.cacheReadTokens;
      if (entry.cacheCreation1hTokens !== undefined) {
        current.cacheCreation1hTokens = (current.cacheCreation1hTokens ?? 0) + entry.cacheCreation1hTokens;
      }
      if (entry.reasoningOutputTokens !== undefined) {
        current.reasoningOutputTokens = (current.reasoningOutputTokens ?? 0) + entry.reasoningOutputTokens;
      }
      if (!seen.has(key)) {
        current.turns += 1;
        seen.add(key);
      }
      this.byExecution.set(key, current);
    }
  }

  toArray(): ExecutionTokenUsage[] {
    return [...this.byExecution.values()].sort((a, b) => executionKey(a).localeCompare(executionKey(b)));
  }
}

/** optional な内数を、1件でも観測できたときだけ合算する。 */
function sumObserved(
  entries: readonly ModelTokenUsage[],
  pick: (entry: ModelTokenUsage) => number | undefined,
): number | undefined {
  let total = 0;
  let observed = false;
  for (const entry of entries) {
    const value = pick(entry);
    if (value === undefined) {
      continue;
    }
    observed = true;
    total += value;
  }
  return observed ? total : undefined;
}

/** 観測した時刻の幅を持つ小さな入れ物。 */
class TimeSpan {
  private first: number | null = null;
  private last: number | null = null;

  observe(ms: number | null): void {
    if (ms === null) {
      return;
    }
    if (this.first === null || ms < this.first) {
      this.first = ms;
    }
    if (this.last === null || ms > this.last) {
      this.last = ms;
    }
  }

  durationMs(): number | null {
    return this.first === null || this.last === null ? null : this.last - this.first;
  }
}

// ---------------------------------------------------------------------------
// claude: ~/.claude/projects/<enc-cwd>/<sessionId>.jsonl ＋ サブエージェント配下
// ---------------------------------------------------------------------------

/**
 * ネイティブ session id として受理する形（契約 §28.6-2）。claude の `--session-id` は uuid、
 * codex の rollout ファイル名に埋まる id も uuid なので、実データはすべてこの形に収まる。
 * `.` を含めないのが要点で、`..` によるディレクトリ脱出を形の段階で成立させない。
 */
export const NATIVE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** ネイティブ session id が受理可能な形かを判定する。 */
export function isValidNativeSessionId(sessionId: string): boolean {
  return NATIVE_SESSION_ID_PATTERN.test(sessionId);
}

/**
 * `candidate` が `root` 配下（root 自身は含まない）に収まっているかを判定する（契約 §28.6-2）。
 * 形式検証の代替ではなく併用する。文字列の startsWith では `/a/bc` が `/a/b` 配下と誤判定されるため、
 * `resolve` 済みの相対パスが `..` で始まらず絶対でもないことで判定する。
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface ClaudeNativeUsageInput {
  /** ~/.claude/projects 相当のルート */
  projectsRoot: string;
  /** launch 時に --session-id で渡した uuid */
  sessionId: string;
}

/**
 * cwd から project ディレクトリ名への符号化（`/` や `.` を `-` へ）を再実装せず、
 * projectsRoot 直下を走査して `<sessionId>.jsonl` を持つディレクトリを探す。
 * uuid はグローバルに一意なので、符号化規則が変わっても壊れない。
 */
export async function findClaudeSessionDir(projectsRoot: string, sessionId: string): Promise<string | null> {
  // `join(dir, sessionId + ".jsonl")` を組み立てる以上、形の検証を欠くと `../` で projectsRoot の
  // 外側の任意 `.jsonl` に到達できる。呼び出し元の検証に頼らずここで閉じる（契約 §28.6-2）。
  if (!isValidNativeSessionId(sessionId)) {
    return null;
  }
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(projectsRoot, entry.name);
    const candidate = join(dir, `${sessionId}.jsonl`);
    // 形式検証と containment は両方課す（片方を他方の代替にしない）。
    if (!isPathWithinRoot(projectsRoot, candidate)) {
      continue;
    }
    if ((await readableLogSize(candidate)) !== "missing") {
      return dir;
    }
  }
  return null;
}

/**
 * サブエージェントのログを再帰的に集める。
 * 現行は `<sessionId>/subagents/agent-*.jsonl` だが、meta.json が spawnDepth を持つ以上
 * より深い階層もありうるため、階層を固定せず `agent-*.jsonl` を配下すべてから拾う。
 */
async function collectAgentLogFiles(dir: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAgentLogFiles(path, found);
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
}

/** 1回の消費。model は課金先で、1応答の中でも message 分と advisor 分で異なる。 */
interface ClaudeModelTokens extends ModelTokenUsage {
  /** cacheCreationTokens の内数のうち 1h TTL 分 */
  cacheCreation1hTokens: number;
}

/** 4系統の合計。行の採否（最終行判定・合成行判定）だけに使い、課金先モデルは持たない。 */
interface ClaudeTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** 1応答（1グループ）の確定 usage。ログ行への参照は持たず数値だけを保持する。 */
interface ClaudeResponseUsage {
  /** 課金先モデル別の消費。message 以外の iteration は別モデルへ按分するため複数になりうる */
  entries: ClaudeModelTokens[];
  /** entries の合計 */
  totals: ClaudeTokenTotals;
  /**
   * **最後の** `type === "message"` iteration の入力側合計＝**このセッションの文脈サイズ**。
   *
   * totals と分けるのは、advisor の iteration が**別の文脈**を持つため。
   * advisor 分は課金には効くが自分の文脈には載っていない。
   *
   * **合計せず最後の1件を採る。** advisor を挟むと後段の message が前段のプロンプトを丸ごと再送するため、
   * 足すとほぼ2倍になる。
   * 実測（本機 `~/.claude/projects` を 1 パスで走査した同一スナップショット。ログは伸び続けるので件数は増える）:
   * 692 ファイル・`iterations` を持つ 54,244 行のうち message iteration が2件以上ある行は 1,119 行。
   * その**全 1,119 行**で「後段の cache_read == 前段の cache_creation + cache_read」が成立した（不成立 0 行）。
   * 実例（0f8f71c0 セッションの1行）: it0 = input 2 / cc 664 / cr 88,370、advisor = input 90,447、
   * it2 = input 2 / cc 1,242 / cr 89,034。89,034 = 664 + 88,370 でプロンプト再送が確認でき、
   * 文脈の実体は it2 の 90,278 だが合計すると 179,314 になる。
   * この誤差は段階判定を素通りしない。同 1,119 行のうち 938 行で段階が変わり、101 行は ok→urgent
   * （最大例: 実体 118,619 = ok に対し合計 236,269 = urgent。e9bee10c セッション）。何も溢れていないのに
   * 「序盤の文脈が失われている」と言って引き継ぎを促す誤報になる。
   *
   * 同 1,119 行では最後の iteration が最大でもあるが、**最大ではなく最後**を採る。
   * ターン途中で文脈が圧縮された場合、最大は圧縮前の値を返して上振れ（＝今回の誤報）を再発させるが、
   * 最後は圧縮後＝次ターンに実際にかかる値を返す。ずれるとしても過小側で、この機能全体の
   * fail-open と同じ向きに倒れる。
  */
  latestMessageInputTokens: number;
  /** latestMessageInputTokens を採ったのと同じ message 応答のモデル。観測できなければ省略する。 */
  contextModel?: string;
}

/** 4系統すべてが 0 か（＝トークンにも金額にも寄与しないか）。 */
function isZeroTokens(t: ClaudeTokenTotals): boolean {
  return t.inputTokens === 0 && t.outputTokens === 0 && t.cacheCreationTokens === 0 && t.cacheReadTokens === 0;
}

/**
 * 1ターンで**プロンプトとして送った側**の合計。文脈サイズと累計入力の両方をこの1つの定義で測る。
 * cache read も cache write も課金対象のプロンプト入力なので、input と同じ側に加える
 * （provider が違っても定義が揺れないよう、claude / codex の両 collector からこの規則だけを使う）。
 */
function inputSideTotal(t: Pick<ClaudeTokenTotals, "inputTokens" | "cacheCreationTokens" | "cacheReadTokens">): number {
  return t.inputTokens + t.cacheCreationTokens + t.cacheReadTokens;
}

/**
 * グループ化して保持する1応答。
 * `main` はサブエージェントを除いた**親セッションの行か**を表す。オーケストレーターの自己計測は
 * 自分の会話ターンで測る必要があり（設計は @hachi/core の MainSessionUsage 参照）、
 * ストリーミング途中経過の行を捨てた後に判定できるよう、行そのものではなくこの旗を持ち回る。
 */
interface ClaudeGroup {
  usage: ClaudeResponseUsage;
  /** assistant 行 top-level の effort。語彙外・未観測は null */
  effort: EffortLevel | null;
  main: boolean;
  /** 行の timestamp（ms）。直近ターンの特定に使う。取れなければ null */
  timestampMs: number | null;
  /** 初出順。timestamp が無い/同値のときの順序に使う（ログは追記順＝時系列） */
  order: number;
}

/**
 * 親セッションだけの内訳を組み立てる。1件も無ければ undefined を返す（0 を書かない）。
 * 直近ターンは timestamp の最大で選び、同値・欠落時は初出順で決める。
 * 途中経過の行は既にグループ内で捨ててあり、input/cache はグループ内で不変なので、
 * ここで見る入力側合計はストリーミングの影響を受けない。
 */
function buildClaudeMainSession(groups: Iterable<ClaudeGroup>): MainSessionUsage | undefined {
  const mainGroups = [...groups]
    .filter((group) => group.main && !isZeroTokens(group.usage.totals))
    .sort((a, b) => a.order - b.order);
  if (mainGroups.length === 0) {
    return undefined;
  }

  let inputTokens = 0;
  let latest: ClaudeGroup | null = null;
  let first: number | null = null;
  let last: number | null = null;
  // 親セッションだけのモデル別内訳。effectiveCostUsd 軸の入力になるため、
  // collectClaudeNativeUsage の観測レベル集計と同じ抽出規則で main 行だけを積む。
  const tokens = new ModelTokenAccumulator();
  const executions = new ExecutionTokenAccumulator();
  const turnSeries: MainSessionTurn[] = [];
  for (const group of mainGroups) {
    inputTokens += inputSideTotal(group.usage.totals);
    const ms = group.timestampMs;
    if (ms !== null) {
      first = first === null || ms < first ? ms : first;
      last = last === null || ms > last ? ms : last;
    }
    if (latest === null || isLaterClaudeGroup(group, latest)) {
      latest = group;
    }
    for (const entry of group.usage.entries) {
      // 0 トークンの iteration も同じ理由で外す（金額に寄与しないモデル名だけを models へ持ち込まない）。
      if (isZeroTokens(entry)) {
        continue;
      }
      tokens.add(entry.model, {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheCreation1hTokens: entry.cacheCreation1hTokens,
        ...(entry.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutputTokens: entry.reasoningOutputTokens }),
      });
    }
    executions.addTurn("claude", group.effort, group.usage.entries);
    const oneHourTokens = sumObserved(group.usage.entries, (entry) => entry.cacheCreation1hTokens);
    const reasoningOutputTokens = sumObserved(group.usage.entries, (entry) => entry.reasoningOutputTokens);
    turnSeries.push({
      provider: "claude",
      ...(group.usage.contextModel === undefined ? {} : { model: group.usage.contextModel }),
      effort: group.effort,
      contextTokens: group.usage.latestMessageInputTokens,
      inputTokens: group.usage.totals.inputTokens,
      outputTokens: group.usage.totals.outputTokens,
      cacheCreationTokens: group.usage.totals.cacheCreationTokens,
      cacheReadTokens: group.usage.totals.cacheReadTokens,
      ...(oneHourTokens === undefined ? {} : { cacheCreation1hTokens: oneHourTokens }),
      ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
      timestampMs: group.timestampMs,
    });
  }
  if (latest === null) {
    return undefined;
  }
  return {
    turns: mainGroups.length,
    inputTokens,
    // 累計は advisor 分も含む（課金は発生している）が、文脈サイズは自分の message 分だけを採る。
    contextTokens: latest.usage.latestMessageInputTokens,
    ...(latest.usage.contextModel === undefined ? {} : { contextModel: latest.usage.contextModel }),
    ...(latest.effort === null ? {} : { contextEffort: latest.effort }),
    elapsedMs: first === null || last === null ? null : last - first,
    perModel: tokens.toArray(),
    perExecution: executions.toArray(),
    turnSeries,
    // claude の transcript には context window サイズの情報が無いため、contextWindowTokens は
    // 常に省略する（新しい定数テーブルでモデル名から逆引きしない）。
  };
}

/** timestamp を優先し、無い/同値なら初出順で「後か」を判定する。 */
function isLaterClaudeGroup(candidate: ClaudeGroup, current: ClaudeGroup): boolean {
  if (candidate.timestampMs !== null && current.timestampMs !== null && candidate.timestampMs !== current.timestampMs) {
    return candidate.timestampMs > current.timestampMs;
  }
  return candidate.order > current.order;
}

/**
 * `usage.cache_creation` から 1h TTL 分を取り出す。
 * 1h の cache write は 5m より単価が高く（LiteLLM で input の 2.0倍 / 5m は 1.25倍）、
 * 本機の実ログでは cache creation 全体の 45%（251.6M トークン）が 1h だった。区別しないと過小評価になる。
 * 内訳の合計が `cache_creation_input_tokens` と一致しない行が実在する（本機 694 行）ため、
 * 一致しないときは内訳を信用せず**全量を 5m 扱い**にする（安全側の単価へ倒す）。
 */
function claudeCacheCreation1h(usage: Record<string, unknown>, total: number): number {
  const breakdown = record(usage.cache_creation);
  if (breakdown === null) {
    return 0;
  }
  const fiveMinutes = nonNegativeInt(breakdown.ephemeral_5m_input_tokens);
  const oneHour = nonNegativeInt(breakdown.ephemeral_1h_input_tokens);
  return fiveMinutes + oneHour === total ? oneHour : 0;
}

/**
 * usage オブジェクト1つから4系統＋1h 内訳を allowlist 抽出する。
 * top-level usage と `usage.iterations[]` の各要素は同じキー形状なので同じ関数で読む。
 */
function claudeTokens(usage: Record<string, unknown>): Omit<ClaudeModelTokens, "model"> {
  const cacheCreationTokens = nonNegativeInt(usage.cache_creation_input_tokens);
  return {
    // claude の input_tokens は cache 分を含まない（cache_read/cache_creation が別建て）。
    inputTokens: nonNegativeInt(usage.input_tokens),
    outputTokens: nonNegativeInt(usage.output_tokens),
    cacheCreationTokens,
    cacheCreation1hTokens: claudeCacheCreation1h(usage, cacheCreationTokens),
    cacheReadTokens: nonNegativeInt(usage.cache_read_input_tokens),
  };
}

/**
 * assistant 行から、集計に使う数値だけを課金先モデル別に allowlist 抽出する。
 *
 * `usage.iterations` があるときは**種別を問わず全 iteration を合算**する。
 * claude の top-level usage は `type === "message"` の iteration 合計に等しく、
 * advisor（`advisor_message`）の分を含まない。
 * 実測: top `input 4 / output 1495` = it0(2/205) + it2(2/1290) で、間に挟まる advisor_message の
 * `input 88,249 / output 9,428` は不算入。top-level だけを読むとこの分が静かに消え、
 * 本機の hachi worktree 配下 91 セッションでは記録 input 39,564 に対し欠落 9,216,403（42 セッションに存在）と
 * 桁で狂った。
 * 「`type !== "message"` を足す」ではなく全 iteration を合算するのは、新しい iteration 種別が増えた瞬間に
 * 同じ落とし方が再発しないようにするため（種別のホワイトリストを持たない）。
 * message 分だけの行は合計が top-level と一致するので、既存の集計は変わらない。
 *
 * **合算するのは課金額（entries / totals）だけ**で、文脈サイズ（`latestMessageInputTokens`）は合算しない。
 * 再送されたプロンプトは cache read として実際に課金されるので総額としては足すのが正しいが、
 * 文脈は最後の message iteration 1件ぶんしか存在しない。
 *
 * 合算結果が4系統すべて 0 になる行は iterations が欠けているとみなし top-level を使う
 * （実測: `iterations: []` の行が本機に 1 行実在する。空を合算すると top-level の実トークンを落とす）。
 */
function extractClaudeResponseUsage(
  row: Record<string, unknown>,
  message: Record<string, unknown>,
  usage: Record<string, unknown>,
): ClaudeResponseUsage {
  const observedMessageModel = text(message.model);
  const messageModel = observedMessageModel ?? "unknown";
  // message 以外（advisor 等）は message.model ではなく行の advisorModel の消費なので、そちらへ按分する。
  // advisorModel を持たない行のために iteration 自身の model → message.model の順でフォールバックする
  // （"unknown" へ倒すと価格表に無いモデルとして run 全体の cost を落とすため、既知のモデル名を優先する）。
  const advisorModel = text(row.advisorModel);
  const entries: ClaudeModelTokens[] = [];
  const totals: ClaudeTokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  // 文脈サイズは合計せず**最後の message iteration で上書きする**（前段プロンプトの再送を二重計上しないため。
  // 根拠は ClaudeResponseUsage.latestMessageInputTokens の docstring）。
  let latestMessageInputTokens = 0;
  let latestMessageModel: string | undefined;
  let messageEntryIndex: number | undefined;
  let sawMessageIteration = false;
  const add = (model: string, tokens: Omit<ClaudeModelTokens, "model">): void => {
    entries.push({ model, ...tokens });
    totals.inputTokens += tokens.inputTokens;
    totals.outputTokens += tokens.outputTokens;
    totals.cacheCreationTokens += tokens.cacheCreationTokens;
    totals.cacheReadTokens += tokens.cacheReadTokens;
  };

  for (const raw of Array.isArray(usage.iterations) ? usage.iterations : []) {
    const iteration = record(raw);
    if (iteration === null) {
      continue;
    }
    const isMessage = iteration.type === "message";
    const model = isMessage ? messageModel : (advisorModel ?? text(iteration.model) ?? messageModel);
    const tokens = claudeTokens(iteration);
    if (isMessage) {
      sawMessageIteration = true;
      latestMessageInputTokens = inputSideTotal(tokens);
      latestMessageModel = text(iteration.model) ?? observedMessageModel ?? undefined;
      messageEntryIndex = entries.length;
    }
    add(model, tokens);
  }
  if (isZeroTokens(totals)) {
    entries.length = 0;
    add(messageModel, claudeTokens(usage));
    messageEntryIndex = 0;
  }
  const outputDetails = record(usage.output_tokens_details);
  const thinkingTokens = optionalNonNegativeInt(outputDetails?.thinking_tokens);
  if (thinkingTokens !== undefined && messageEntryIndex !== undefined) {
    entries[messageEntryIndex]!.reasoningOutputTokens = thinkingTokens;
  }
  // 0 を top-level へ倒す条件が拾うのは次の3ケース。
  //   1. `iterations` を持たない行（通常の応答。top-level がそのまま文脈）
  //   2. `iterations` はあるが message iteration が1件も無い行
  //   3. 最後の message iteration の入力側が 0（＝`iterations: []` 相当の潰れた行）
  // 3 は「最後より前が非 0 なのに最後だけ 0」だと合計値（= top-level）へ倒れて二重計上に戻るが、
  // その形は実測 1,119 行すべてで最後が最大だったため起こらない（最後が 0 なら全 iteration が 0）。
  // 逆に top-level 側が 0 で潰れている行が実在する（本機 4 行。cache read 998,206 を持つ message
  // iteration に対し top-level が全系統 0）ため、**message iteration があるときはそちらを優先する**。
  const contextModel = sawMessageIteration ? latestMessageModel : (observedMessageModel ?? undefined);
  return {
    entries,
    totals,
    latestMessageInputTokens:
      latestMessageInputTokens === 0 ? inputSideTotal(claudeTokens(usage)) : latestMessageInputTokens,
    ...(contextModel === undefined ? {} : { contextModel }),
  };
}

/**
 * claude のネイティブ transcript から usage を集計する。
 *
 * - 親セッション＋配下のサブエージェント全ファイルを**合算**する（設計 R2。親だけでは過小評価）
 * - 1回の API 応答が複数行に分かれるため (requestId, message.id) で**グループ化**し、
 *   グループ内で `output_tokens` が最大の行＝**最終行**の usage を採る。
 *   実ログでは output_tokens だけがストリーミング途中経過として増加し、input/cache は不変
 *   （実測: 199a85b5 セッションで 370 行→173 グループ、うち 148 グループが複数行で
 *   148/148 が単調増加かつ last==max）。
 *   先頭行を採ると途中経過の値を確定値と取り違えて output を落とし（同セッションで 40,474 トークン=36.6%、
 *   本機の subagent ログ全体では 86.9%）、グループ化しないと 2 倍以上に二重計上する。
 *   **行ごとに最大値を採るのではなく1行を丸ごと採る**のは、4系統と 5m/1h 内訳の整合を崩さないため
 * - `cache_read_input_tokens` を必ず拾う（実例 144,970 を捨てていたのが今回の根因）
 * - `usage.iterations` を持つ行は**全 iteration を合算**する。top-level は message 分だけの合計で、
 *   advisor 分を含まない（`extractClaudeResponseUsage` 参照）。advisor 分は行の `advisorModel` へ按分する
 * - 4系統すべてが 0 の合成行（`model:"<synthetic>"`。セッション上限・ログイン切れで書かれ、
 *   本機に 25 行/17 セッション実在）は集計から外す。金額に寄与しない一方で models を汚し、
 *   価格表に無いモデルとして run 全体の cost を落としてしまうため
 */
export async function collectClaudeNativeUsage(input: ClaudeNativeUsageInput): Promise<NativeUsageObservation> {
  const dir = await findClaudeSessionDir(input.projectsRoot, input.sessionId);
  if (dir === null) {
    return unavailable("log-not-found");
  }

  const parentFile = join(dir, `${input.sessionId}.jsonl`);
  const files = [parentFile];
  await collectAgentLogFiles(join(dir, input.sessionId), files);

  const tokens = new ModelTokenAccumulator();
  const span = new TimeSpan();
  // 親とサブエージェントで単一の Map を共有する。sidechain がどちらに現れても二重計上しない。
  // 値は行そのものではなく抽出済みの数値だけを持つ（巨大ログで content ブロックを抱え込まないため）。
  const groups = new Map<string, ClaudeGroup>();
  let order = 0;

  for (const file of files) {
    const size = await readableLogSize(file);
    if (size === "too-large") {
      return unavailable("log-unreadable");
    }
    if (size === "missing") {
      continue;
    }
    for await (const row of readJsonLines(file)) {
      if (row.type !== "assistant") {
        continue;
      }
      const message = record(row.message);
      if (message === null) {
        continue;
      }
      const usage = record(message.usage);
      // API エラー行など usage を持たないレコードは「0 トークンの応答」ではないので数えない。
      if (usage === null) {
        continue;
      }
      // requestId が無いレコードが実在するため message.id → uuid の順にフォールバックする。
      const key = text(row.requestId) ?? text(message.id) ?? text(row.uuid);
      if (key === null) {
        continue;
      }
      const dedupKey = `${key}:${text(message.id) ?? ""}`;
      const timestampMs = epochMs(row.timestamp);
      span.observe(timestampMs);
      const extracted = extractClaudeResponseUsage(row, message, usage);
      const existing = groups.get(dedupKey);
      // 親ファイルの行でも `isSidechain: true` はサブエージェント側の応答なので自分の文脈ではない。
      // これを混ぜると直近ターンがサブエージェントの小さい文脈になり、上限付近でも ok に見えてしまう。
      const main = file === parentFile && row.isSidechain !== true;
      // 同一グループでは output が最大の行＝最終行を残す（途中経過の行を捨てる）。
      if (existing === undefined) {
        groups.set(dedupKey, {
          usage: extracted,
          effort: parseEffortLevel(row.effort),
          main,
          timestampMs,
          order: order++,
        });
        continue;
      }
      if (extracted.totals.outputTokens > existing.usage.totals.outputTokens) {
        existing.usage = extracted;
        existing.effort = parseEffortLevel(row.effort);
        existing.timestampMs = timestampMs ?? existing.timestampMs;
      }
      // 同じ応答が親とサブエージェント両方に現れても、親側の行が1つでもあれば自分のターンとして数える。
      existing.main = existing.main || main;
    }
  }

  let turns = 0;
  for (const { usage: group } of groups.values()) {
    // 4系統すべて 0 の合成行はトークンにも金額にも寄与しない。models / turns を汚さないよう外す。
    if (isZeroTokens(group.totals)) {
      continue;
    }
    turns += 1;
    for (const entry of group.entries) {
      // 0 トークンの iteration も同じ理由で外す（金額に寄与しないモデル名だけを models へ持ち込まない）。
      if (isZeroTokens(entry)) {
        continue;
      }
      tokens.add(entry.model, {
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheCreationTokens: entry.cacheCreationTokens,
        cacheReadTokens: entry.cacheReadTokens,
        cacheCreation1hTokens: entry.cacheCreation1hTokens,
        ...(entry.reasoningOutputTokens === undefined
          ? {}
          : { reasoningOutputTokens: entry.reasoningOutputTokens }),
      });
    }
  }

  if (turns === 0) {
    return unavailable("no-usage-records");
  }
  const mainSession = buildClaudeMainSession(groups.values());
  return {
    observed: true,
    perModel: tokens.toArray(),
    turns,
    durationMs: span.durationMs(),
    // 親セッションの行が1つも無い（サブエージェントのログしか読めなかった）ときはキーごと省略する。
    ...(mainSession !== undefined ? { mainSession } : {}),
  };
}

// ---------------------------------------------------------------------------
// codex: ~/.codex/sessions/**/rollout-*-<sessionId>.jsonl
// ---------------------------------------------------------------------------

/** `codex exec` が `.out` 冒頭へ出力するヘッダから session id を取り出す（時刻推測を使わないための鍵）。 */
const CODEX_SESSION_ID_LINE = /^\s*session[ _-]?id:\s*([0-9a-fA-F-]{36})\s*$/m;

/** `.out` 全文（または冒頭）から codex の session id を取り出す。見つからなければ null。 */
export function parseCodexSessionId(outText: string): string | null {
  const matched = CODEX_SESSION_ID_LINE.exec(outText);
  return matched?.[1]?.toLowerCase() ?? null;
}

export interface CodexNativeUsageInput {
  /** ~/.codex/sessions 相当のルート */
  sessionsRoot: string;
  /** `.out` ヘッダから取り出した session id */
  sessionId: string;
}

/** rollout ファイルを uuid の完全一致で探す（`rollout-<ts>-<uuid>.jsonl`）。日付ディレクトリは推測しない。 */
export async function findCodexRollout(sessionsRoot: string, sessionId: string): Promise<string | null> {
  // ファイル名の suffix 一致にしか使わないため `../` 単体では脱出できないが、契約 §28.6-2 の
  // 「形式検証と containment を両方課す」に合わせ、claude 側と同じ規律をここにも敷く。
  if (!isValidNativeSessionId(sessionId)) {
    return null;
  }
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const stack = [sessionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.toLowerCase().endsWith(suffix)) {
        if (!isPathWithinRoot(sessionsRoot, path)) {
          continue;
        }
        return path;
      }
    }
  }
  return null;
}

/** token_count の累積スナップショット（codex が持つ 4 つの生カウンタ）。 */
interface CodexTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  /** output の内数。ログが報告しない場合は undefined */
  reasoning: number | undefined;
}

const ZERO_TOTALS: CodexTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };

function readCodexTotals(info: Record<string, unknown>): CodexTotals | null {
  const total = record(info.total_token_usage);
  if (total === null) {
    return null;
  }
  return {
    input: nonNegativeInt(total.input_tokens),
    cached: nonNegativeInt(total.cached_input_tokens),
    cacheWrite: nonNegativeInt(total.cache_write_input_tokens),
    output: nonNegativeInt(total.output_tokens),
    reasoning: optionalNonNegativeInt(total.reasoning_output_tokens),
  };
}

/**
 * codex の rollout から usage を集計する。
 *
 * トークンの意味論（実測で確認）:
 *   total_tokens == input_tokens + output_tokens、かつ cached_input_tokens は input_tokens の**内数**、
 *   reasoning_output_tokens は output_tokens の**内数**。したがって互いに素な 4 系統は
 *   `input - cached` / `cached` / `cache_write` / `output` であり、reasoning を第5の加算項にしてはならない。
 *
 * 集計方法:
 *   token_count イベントは同じ last_token_usage を連続で重複出力することがある（実測 3623 件中 67 件）。
 *   一方 total_token_usage は単調増加する累積値なので、**連続する累積値の差分**を取り、その時点の
 *   turn_context のモデルへ按分する。重複イベントは差分 0 になり自動的に無視される。
 */
export async function collectCodexNativeUsage(input: CodexNativeUsageInput): Promise<NativeUsageObservation> {
  const path = await findCodexRollout(input.sessionsRoot, input.sessionId);
  if (path === null) {
    return unavailable("log-not-found");
  }
  const size = await readableLogSize(path);
  if (size === "too-large") {
    return unavailable("log-unreadable");
  }
  if (size === "missing") {
    return unavailable("log-not-found");
  }

  const tokens = new ModelTokenAccumulator();
  const executions = new ExecutionTokenAccumulator();
  const turnSeries: MainSessionTurn[] = [];
  const span = new TimeSpan();
  let currentModel: string | null = null;
  let currentEffort: EffortLevel | null = null;
  let previous = ZERO_TOTALS;
  let turns = 0;
  let sawTokenCount = false;
  // codex には子セッションの概念が無いので rollout 全体がそのまま「親セッション」になる。
  let mainInputTokens = 0;
  let contextTokens = 0;
  let contextModel: string | undefined;
  let currentTurnContextModel: string | undefined;
  let contextEffort: EffortLevel | null = null;
  let contextWindowTokens: number | undefined;

  for await (const row of readJsonLines(path)) {
    const payload = record(row.payload);
    if (payload === null) {
      continue;
    }
    if (row.type === "turn_context") {
      currentTurnContextModel = text(payload.model) ?? undefined;
      currentModel = text(payload.model) ?? currentModel;
      currentEffort = parseEffortLevel(payload.effort);
      continue;
    }
    if (row.type === "session_meta") {
      currentModel = currentModel ?? text(payload.model);
      continue;
    }
    if (row.type !== "event_msg" || payload.type !== "token_count") {
      continue;
    }
    const info = record(payload.info);
    if (info === null) {
      continue;
    }
    const totals = readCodexTotals(info);
    if (totals === null) {
      continue;
    }
    sawTokenCount = true;
    span.observe(epochMs(row.timestamp));

    // 既存4系統の累積値が減っていたら別カウンタが始まった（resume/圧縮）とみなし、baseline を 0 へ戻す。
    // reasoning は output の内数かつ報告が欠落し得るため、その減少を4系統の reset 根拠にはしない。
    const reset =
      totals.input < previous.input ||
      totals.cached < previous.cached ||
      totals.cacheWrite < previous.cacheWrite ||
      totals.output < previous.output;
    const base = reset ? ZERO_TOTALS : previous;
    const inputDelta = totals.input - base.input;
    const cachedDelta = totals.cached - base.cached;
    const cacheWriteDelta = totals.cacheWrite - base.cacheWrite;
    const outputDelta = totals.output - base.output;
    const reasoningReset =
      totals.reasoning !== undefined && previous.reasoning !== undefined && totals.reasoning < previous.reasoning;
    const reasoningBase = reset || reasoningReset ? 0 : previous.reasoning;
    const reasoningDelta =
      totals.reasoning === undefined || reasoningBase === undefined
        ? undefined
        : totals.reasoning - reasoningBase;
    previous = totals;

    // cached は input の内数という前提が崩れたら、差し引きで負値を作らず観測不能として扱う
    // （0 へ丸めると「安いが妥当そうな数値」になり、誤りが誰にも観測されない）。
    if (cachedDelta > inputDelta) {
      return unavailable("log-unreadable");
    }
    if (reasoningDelta !== undefined && reasoningDelta > outputDelta) {
      return unavailable("log-unreadable");
    }
    if (inputDelta === 0 && outputDelta === 0 && cacheWriteDelta === 0) {
      continue;
    }
    turns += 1;
    tokens.add(currentModel ?? "unknown", {
      inputTokens: inputDelta - cachedDelta,
      outputTokens: outputDelta,
      cacheCreationTokens: cacheWriteDelta,
      cacheReadTokens: cachedDelta,
      ...(reasoningDelta === undefined ? {} : { reasoningOutputTokens: reasoningDelta }),
    });
    const turnUsage: ModelTokenUsage = {
      model: currentModel ?? "unknown",
      inputTokens: inputDelta - cachedDelta,
      outputTokens: outputDelta,
      cacheCreationTokens: cacheWriteDelta,
      cacheReadTokens: cachedDelta,
      ...(reasoningDelta === undefined ? {} : { reasoningOutputTokens: reasoningDelta }),
    };
    executions.addTurn("codex", currentEffort, [turnUsage]);
    // cached は input の内数なので、入力側合計は cached を足し直さず inputDelta + cache write で足りる。
    // claude 側の inputSideTotal と同じ「プロンプトとして送った側の合計」を指す。
    const turnInput = inputDelta + cacheWriteDelta;
    mainInputTokens += turnInput;
    // 累積値の差分は常に直近ターンの消費なので、最後に上書きされた値がその時点の文脈サイズになる。
    contextTokens = turnInput;
    // contextTokens と同じ token_count 応答に適用されている turn_context のモデルだけを採る。
    // モデルを観測できていなければ累計 perModel から推測せず undefined のままにする。
    contextModel = currentTurnContextModel;
    contextEffort = currentEffort;
    turnSeries.push({
      provider: "codex",
      ...(currentTurnContextModel === undefined ? {} : { model: currentTurnContextModel }),
      effort: currentEffort,
      contextTokens: turnInput,
      inputTokens: inputDelta - cachedDelta,
      outputTokens: outputDelta,
      cacheCreationTokens: cacheWriteDelta,
      cacheReadTokens: cachedDelta,
      ...(reasoningDelta === undefined ? {} : { reasoningOutputTokens: reasoningDelta }),
      timestampMs: epochMs(row.timestamp),
    });
    // context window サイズも「最後に観測した値が勝つ」同じ規約。後続イベントで欠けていても
    // 直前の観測値をクリアしない（provider が毎回報告するとは限らないため）。
    const window = positiveNumber(info.model_context_window);
    if (window !== undefined) {
      contextWindowTokens = window;
    }
  }

  if (!sawTokenCount || tokens.size === 0) {
    return unavailable("no-usage-records");
  }
  return {
    observed: true,
    perModel: tokens.toArray(),
    turns,
    durationMs: span.durationMs(),
    mainSession: {
      turns,
      inputTokens: mainInputTokens,
      contextTokens,
      ...(contextModel === undefined ? {} : { contextModel }),
      ...(contextEffort === null ? {} : { contextEffort }),
      elapsedMs: span.durationMs(),
      perModel: tokens.toArray(),
      perExecution: executions.toArray(),
      turnSeries,
      ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
    },
  };
}
