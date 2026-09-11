// =============================================================================
// hachi knowledge: session-handover 等の知見を看板 DB に格納・参照する。
// =============================================================================

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import type {
  ActorProvenance,
  KnowledgeAddInput,
  KnowledgeListOptions,
  KnowledgeRow,
  KanbanStore,
} from "@hachi/core";
import type { CliDeps } from "../deps.js";
import { withErrorHandling } from "../errors.js";
import { emit, singularResourceEnvelope } from "../output.js";
import {
  addActorPrincipalOptions,
  resolveActorProvenance,
  type ActorPrincipalOptions,
} from "../actor-provenance.js";

const DEFAULT_ACTOR = "human";
const INGEST_SOURCE = "session-handover";

interface KnowledgeStore extends KanbanStore {
  addKnowledge(input: KnowledgeAddInput, actor: string, provenance?: ActorProvenance): KnowledgeRow;
  listKnowledge(options?: KnowledgeListOptions): KnowledgeRow[];
  getKnowledge(id: string): KnowledgeRow | null;
}

interface KnowledgeJsonOption {
  json?: boolean;
}

interface KnowledgeAddOptions extends KnowledgeJsonOption, ActorPrincipalOptions {
  title: string;
  body?: string;
  file?: string;
  source?: string;
  tags?: string[];
  importance?: number;
  author?: string;
}

interface KnowledgeListCliOptions extends KnowledgeJsonOption {
  tag?: string;
  source?: string;
  includeExpired?: boolean;
  limit?: number;
}

interface KnowledgeIngestOptions extends KnowledgeJsonOption, ActorPrincipalOptions {
  dir: string;
  author?: string;
}

interface ParsedFrontmatter {
  values: Record<string, string | string[]>;
  body: string;
}

interface IngestSummary {
  added: number;
  skipped: number;
  failed: number;
  failures: Array<{ path: string; error: string }>;
}

function knowledgeStore(deps: CliDeps): KnowledgeStore {
  return deps.store as unknown as KnowledgeStore;
}

function parsePositiveIntArg(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`正の整数を指定してください: ${value}`);
  }
  return Number.parseInt(value, 10);
}

function parseImportanceArg(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new InvalidArgumentError(`--importance は 0〜100 の整数で指定してください: ${value}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 0 || parsed > 100) {
    throw new InvalidArgumentError(`--importance は 0〜100 の整数で指定してください: ${value}`);
  }
  return parsed;
}

function parseTagsArg(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

function readBodyOption(options: KnowledgeAddOptions): string {
  const hasBody = options.body !== undefined;
  const hasFile = options.file !== undefined;
  if (hasBody === hasFile) {
    throw new Error("--body または --file のどちらか一方だけを指定してください");
  }
  if (options.body !== undefined) {
    return options.body;
  }
  return readFileSync(options.file ?? "", "utf8");
}

function formatKnowledgeLine(row: KnowledgeRow): string {
  const tags = row.tags.length > 0 ? row.tags.join(",") : "-";
  const expires = row.expiresAt === null ? "-" : String(row.expiresAt);
  return `${row.id} importance=${row.importance} source=${row.source} tags=${tags} expires_at=${expires} ${row.title}`;
}

function formatKnowledgeDetail(row: KnowledgeRow): string[] {
  return [
    formatKnowledgeLine(row),
    `origin_path: ${row.originPath === "" ? "-" : row.originPath}`,
    `content_hash: ${row.contentHash}`,
    `actor: ${row.actor}`,
    `provenance: kind=${row.provenance.kind} actor_id=${row.provenance.actorId || "-"} ` +
      `session=${row.provenance.actorSessionId || "-"} generation=${row.provenance.actorGeneration ?? "-"}`,
    `created_at: ${row.createdAt}`,
    `updated_at: ${row.updatedAt}`,
    "",
    row.body,
  ];
}

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return [parseScalar(value)];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  return inner.split(",").map(parseScalar).filter((item) => item.length > 0);
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { values: {}, body: text };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex === -1) {
    return { values: {}, body: text };
  }

  const values: Record<string, string | string[]> = {};
  let currentArrayKey: string | null = null;
  for (const line of lines.slice(1, endIndex)) {
    const arrayMatch = /^\s*-\s*(.*)$/.exec(line);
    if (arrayMatch !== null && currentArrayKey !== null) {
      const item = parseScalar(arrayMatch[1] ?? "");
      const current = values[currentArrayKey];
      if (Array.isArray(current) && item.length > 0) {
        current.push(item);
      }
      continue;
    }

    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyMatch === null || keyMatch[1] === undefined || keyMatch[2] === undefined) {
      currentArrayKey = null;
      continue;
    }

    const key = keyMatch[1];
    const value = keyMatch[2];
    if (value.trim() === "") {
      values[key] = [];
      currentArrayKey = key;
      continue;
    }
    if (value.trim().startsWith("[") && value.trim().endsWith("]")) {
      values[key] = parseInlineArray(value);
    } else {
      values[key] = parseScalar(value);
    }
    currentArrayKey = null;
  }

  return { values, body: lines.slice(endIndex + 1).join("\n").trimStart() };
}

function frontmatterString(values: Record<string, string | string[]>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function frontmatterArray(values: Record<string, string | string[]>, key: string): string[] | undefined {
  const value = values[key];
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return parseInlineArray(value);
  }
  return undefined;
}

function parseOptionalEpoch(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return undefined;
  }
  return Math.floor(millis / 1000);
}

function parseOptionalImportance(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1].trim();
    }
  }
  return undefined;
}

function titleFromPath(path: string): string {
  const name = basename(path);
  return extname(name) === ".md" ? name.slice(0, -3) : name;
}

function buildKnowledgeInputFromMarkdown(path: string, text: string): KnowledgeAddInput {
  const parsed = parseFrontmatter(text);
  const topic = frontmatterString(parsed.values, "topic");
  const title = topic ?? firstHeading(parsed.body) ?? titleFromPath(path);
  const input: KnowledgeAddInput = {
    title,
    body: parsed.body.trim(),
    source: INGEST_SOURCE,
    originPath: path,
  };
  const tags = frontmatterArray(parsed.values, "tags");
  if (tags !== undefined) {
    input.tags = tags;
  }
  const importance = parseOptionalImportance(frontmatterString(parsed.values, "importance"));
  if (importance !== undefined) {
    input.importance = importance;
  }
  const expiresAt = parseOptionalEpoch(frontmatterString(parsed.values, "expires_at"));
  if (expiresAt !== undefined) {
    input.expiresAt = expiresAt;
  }
  const createdAt = parseOptionalEpoch(frontmatterString(parsed.values, "created"));
  if (createdAt !== undefined) {
    input.createdAt = createdAt;
  }
  return input;
}

function requireKnowledge(deps: CliDeps, id: string): KnowledgeRow {
  const row = knowledgeStore(deps).getKnowledge(id);
  if (row === null) {
    throw new Error(`knowledge が見つかりません: ${id}`);
  }
  return row;
}

function runAdd(deps: CliDeps, options: KnowledgeAddOptions): void {
  const input: KnowledgeAddInput = {
    title: options.title,
    body: readBodyOption(options),
  };
  if (options.source !== undefined) {
    input.source = options.source;
  }
  if (options.tags !== undefined) {
    input.tags = options.tags;
  }
  if (options.importance !== undefined) {
    input.importance = options.importance;
  }

  const actor = options.author ?? DEFAULT_ACTOR;
  const provenance = resolveActorProvenance(options, actor);
  const row = knowledgeStore(deps).addKnowledge(input, actor, provenance);
  emit(
    deps,
    options.json === true,
    singularResourceEnvelope(row, { knowledge: row }),
    [`knowledge を保存しました: ${row.id}`],
  );
}

function runList(deps: CliDeps, options: KnowledgeListCliOptions): void {
  const listOptions: KnowledgeListOptions = {};
  if (options.tag !== undefined) {
    listOptions.tag = options.tag;
  }
  if (options.source !== undefined) {
    listOptions.source = options.source;
  }
  if (options.includeExpired !== undefined) {
    listOptions.includeExpired = options.includeExpired;
  }
  if (options.limit !== undefined) {
    listOptions.limit = options.limit;
  }
  const rows = knowledgeStore(deps).listKnowledge(listOptions);
  const text = rows.length === 0 ? ["(knowledge はありません)"] : rows.map(formatKnowledgeLine);
  emit(deps, options.json === true, { knowledge: rows }, text);
}

function runShow(deps: CliDeps, id: string, options: KnowledgeJsonOption): void {
  const row = requireKnowledge(deps, id);
  emit(deps, options.json === true, singularResourceEnvelope(row, { knowledge: row }), formatKnowledgeDetail(row));
}

function existingKnowledgeHashes(deps: CliDeps): Set<string> {
  return new Set(
    knowledgeStore(deps)
      .listKnowledge({ includeExpired: true, limit: Number.MAX_SAFE_INTEGER })
      .map((row) => row.contentHash),
  );
}

function runIngestSessions(deps: CliDeps, options: KnowledgeIngestOptions): void {
  const dir = resolve(options.dir);
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`--dir はディレクトリを指定してください: ${dir}`);
  }

  const hashes = existingKnowledgeHashes(deps);
  const actor = options.author ?? DEFAULT_ACTOR;
  const provenance = resolveActorProvenance(options, actor);
  const summary: IngestSummary = { added: 0, skipped: 0, failed: 0, failures: [] };
  const files = readdirSync(dir)
    .filter((name) => extname(name).toLowerCase() === ".md")
    .sort((a, b) => a.localeCompare(b));

  for (const name of files) {
    const path = resolve(dir, name);
    try {
      if (!statSync(path).isFile()) {
        continue;
      }
      const text = readFileSync(path, "utf8");
      const input = buildKnowledgeInputFromMarkdown(path, text);
      const bodyHash = hashBody(input.body);
      const alreadyExists = hashes.has(bodyHash);
      const row = knowledgeStore(deps).addKnowledge(input, actor, provenance);
      hashes.add(row.contentHash);
      if (alreadyExists) {
        summary.skipped += 1;
      } else {
        summary.added += 1;
      }
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  emit(
    deps,
    options.json === true,
    { summary },
    [`ingest-sessions: added=${summary.added} skipped=${summary.skipped} failed=${summary.failed}`],
  );
}

export function registerKnowledgeCommand(program: Command, deps: CliDeps): void {
  const knowledge = program.command("knowledge").description("knowledge 面の操作");

  const add = knowledge
    .command("add")
    .description("knowledge を追加する")
    .requiredOption("--title <title>", "タイトル")
    .option("--body <text>", "本文")
    .option("--file <path>", "本文ファイル")
    .option("--source <source>", "source")
    .option("--tags <a,b>", "カンマ区切りタグ", parseTagsArg)
    .option("--importance <n>", "importance（0〜100）", parseImportanceArg)
    .option("--author <author>", "表示上の実行者", DEFAULT_ACTOR);
  addActorPrincipalOptions(add)
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: KnowledgeAddOptions): void => runAdd(deps, options)));

  knowledge
    .command("list")
    .description("knowledge 一覧を表示する")
    .option("--tag <tag>", "タグで絞り込む")
    .option("--source <source>", "source で絞り込む")
    .option("--include-expired", "expires_at 切れを含める")
    .option("--limit <n>", "表示件数（既定 20）", parsePositiveIntArg)
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (options: KnowledgeListCliOptions): void => runList(deps, options)));

  knowledge
    .command("show")
    .description("knowledge 詳細を表示する")
    .argument("<id>", "knowledge ID")
    .option("--json", "JSON 形式で出力する")
    .action(withErrorHandling(deps, (id: string, options: KnowledgeJsonOption): void => runShow(deps, id, options)));

  const ingestSessions = knowledge
    .command("ingest-sessions")
    .description("session-handover markdown を一括取込する")
    .requiredOption("--dir <path>", "取込元ディレクトリ")
    .option("--author <author>", "表示上の実行者", DEFAULT_ACTOR);
  addActorPrincipalOptions(ingestSessions)
    .option("--json", "JSON 形式で出力する")
    .action(
      withErrorHandling(deps, (options: KnowledgeIngestOptions): void => runIngestSessions(deps, options)),
    );
}
