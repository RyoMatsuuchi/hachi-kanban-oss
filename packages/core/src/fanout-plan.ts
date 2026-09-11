import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { z } from "zod";
import { redactText } from "./redaction.js";

export const FANOUT_PLAN_INPUT_VERSION = "fanout-plan-input.v1" as const;
export const FANOUT_PLAN_VERSION = "fanout-plan.v1" as const;

const SAFE_CHILD_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID = /^t_[A-Za-z0-9]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const WILDCARD = /[*?[\]{}]/;
const FORBIDDEN_GIT_COMMANDS = new Set([
  "pull",
  "push",
  "cherry-pick",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "switch",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);
const FORBIDDEN_CONFLICT_INSTRUCTION =
  /\bauto(?:matic(?:ally)?)?[- ]?(?:resolve|fix)[- ]?conflicts?\b/i;

const parentSnapshotSchema = z
  .object({
    taskId: z.string().regex(TASK_ID),
    updatedAt: z.number().int().nonnegative(),
    bodyHash: z.string().regex(SHA256),
  })
  .strict();

const childSchema = z
  .object({
    key: z.string().regex(SAFE_CHILD_KEY),
    title: z.string().min(1),
    body: z.string().min(1),
    tenant: z.string().min(1),
    profile: z.string().min(1),
    worktree: z.string().min(1),
    ownership: z.array(z.string()).min(1),
    dependsOn: z.array(z.string()),
  })
  .strict();

const inputSchema = z
  .object({
    version: z.literal(FANOUT_PLAN_INPUT_VERSION),
    parentTaskId: z.string().regex(TASK_ID),
    parentSnapshot: parentSnapshotSchema,
    repoCommonDir: z.string().min(1),
    scopeRoots: z.array(z.string()).min(1),
    children: z.array(childSchema).min(3).max(6),
    integrationGate: z
      .object({
        requiredChildren: z.array(z.string()).min(3).max(6),
      })
      .strict(),
  })
  .strict();

export interface FanoutParentSnapshot {
  taskId: string;
  updatedAt: number;
  bodyHash: string;
}

export interface FanoutPlanChild {
  key: string;
  title: string;
  body: string;
  tenant: string;
  profile: string;
  worktree: string;
  ownership: string[];
  dependsOn: string[];
}

export interface FanoutPlanInput {
  version: typeof FANOUT_PLAN_INPUT_VERSION;
  parentTaskId: string;
  parentSnapshot: FanoutParentSnapshot;
  repoCommonDir: string;
  scopeRoots: string[];
  children: FanoutPlanChild[];
  integrationGate: {
    requiredChildren: string[];
  };
}

export interface FanoutPlan {
  version: typeof FANOUT_PLAN_VERSION;
  inputVersion: typeof FANOUT_PLAN_INPUT_VERSION;
  parentTaskId: string;
  parentSnapshot: FanoutParentSnapshot;
  repoCommonDir: string;
  scopeRoots: string[];
  children: FanoutPlanChild[];
  integrationGate: {
    requiredChildren: string[];
  };
  planHash: string;
}

export interface FanoutPlanResult {
  plan: FanoutPlan;
  canonicalJson: string;
  planHash: string;
}

type CanonicalPlanPayload = Omit<FanoutPlan, "planHash">;

/** 親bodyをhash用に正規化する。意味文字列には触れず、改行だけを契約どおり揃える。 */
export function normalizeFanoutParentBody(body: string): string {
  const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(/\n+$/u, "");
  return `${normalized}\n`;
}

/** 正規化済み親bodyのSHA-256を返す。 */
export function hashFanoutParentBody(body: string): string {
  return createHash("sha256").update(normalizeFanoutParentBody(body), "utf8").digest("hex");
}

function fail(message: string): never {
  throw new Error(`fan-out plan: ${message}`);
}

function parseInput(input: unknown): FanoutPlanInput {
  const result = inputSchema.safeParse(input);
  if (!result.success) {
    return fail("入力schemaが不正です");
  }
  return result.data;
}

function canonicalAbsolutePath(value: string, label: string): string {
  if (value.includes("\0") || !isAbsolute(value) || normalize(value) !== value || value.endsWith(sep)) {
    return fail(`${label}は絶対canonical pathである必要があります`);
  }
  return value;
}

function assertNoSecretLikeValues(input: FanoutPlanInput): void {
  const values = [
    input.parentTaskId,
    input.parentSnapshot.taskId,
    input.repoCommonDir,
    ...input.scopeRoots,
    ...input.integrationGate.requiredChildren,
    ...input.children.flatMap((child) => [
      child.key,
      child.title,
      child.body,
      child.tenant,
      child.profile,
      child.worktree,
      ...child.ownership,
      ...child.dependsOn,
    ]),
  ];
  if (values.some((value) => redactText(value) !== value)) {
    fail("secret-like value is not allowed");
  }
}

function shellTokens(text: string): string[] {
  // wrapperへ渡す引用commandも保守的に検査するため、引用符を境界として平坦化する。
  // shell完全解析はせず、過剰許可より過剰拒否を選ぶ。
  return text.replace(/["'`]/g, " ").match(/\S+/g) ?? [];
}

function normalizedShellToken(token: string): string {
  return token.replace(/^["'`;(){}]+|["'`;(){}.,:]+$/g, "");
}

function isGitExecutableToken(token: string): boolean {
  const normalized = normalizedShellToken(token).replaceAll("\\", "/");
  const executable = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return executable === "git" || executable === "git.exe";
}

function containsForbiddenGitOperation(text: string): boolean {
  const tokens = shellTokens(text);
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (current === undefined || !isGitExecutableToken(current)) {
      continue;
    }
    let commandIndex = index + 1;
    while (commandIndex < tokens.length) {
      const candidate = normalizedShellToken(tokens[commandIndex] ?? "");
      if (!candidate.startsWith("-")) {
        break;
      }
      commandIndex += GIT_GLOBAL_OPTIONS_WITH_VALUE.has(candidate) ? 2 : 1;
    }
    const command = normalizedShellToken(tokens[commandIndex] ?? "").toLowerCase();
    if (FORBIDDEN_GIT_COMMANDS.has(command)) {
      return true;
    }
  }
  return false;
}

function canonicalWorktree(value: string): string {
  const worktree = canonicalAbsolutePath(value, "worktree");
  const root = normalize(join(homedir(), ".hachi-kanban", "worktrees"));
  if (!worktree.startsWith(`${root}${sep}`) || worktree === root) {
    return fail("worktreeは~/.hachi-kanban/worktrees配下である必要があります");
  }
  return worktree;
}

function canonicalRelativePath(value: string): string {
  if (value === "" || value.includes("\0") || isAbsolute(value) || WILDCARD.test(value)) {
    return fail("ownership pathが不正です");
  }
  const slashNormalized = value.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of slashNormalized.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return fail("ownership pathがscope外へescapeしています");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const canonical = segments.join("/");
  if (canonical === "" || canonical === "." || canonical === "..") {
    return fail("ownership pathが空またはdot pathです");
  }
  return canonical;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isSameOrDescendant(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assertNoDuplicates(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail(`${label}に重複があります`);
  }
}

function assertChildKeys(children: FanoutPlanChild[]): void {
  const keys = children.map((child) => child.key);
  assertNoDuplicates(keys, "child key");
  const keySet = new Set(keys);
  for (const child of children) {
    assertNoDuplicates(child.dependsOn, "dependsOn");
    for (const dependency of child.dependsOn) {
      if (!keySet.has(dependency) || dependency === child.key) {
        fail("dependsOnが未知childまたは自己参照です");
      }
    }
  }
}

function assertAcyclic(children: FanoutPlanChild[]): void {
  const byKey = new Map(children.map((child) => [child.key, child]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) {
      fail("dependsOnに循環があります");
    }
    if (visited.has(key)) {
      return;
    }
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn ?? []) {
      visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const child of children) {
    visit(child.key);
  }
}

function assertOwnership(scopeRoots: string[], children: FanoutPlanChild[]): void {
  const owners: Array<{ childKey: string; path: string }> = [];
  for (const child of children) {
    for (const path of child.ownership) {
      if (!scopeRoots.some((root) => isSameOrDescendant(path, root))) {
        fail("ownershipがscopeRoots外です");
      }
      owners.push({ childKey: child.key, path });
    }
  }

  for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
    const left = owners[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
      const right = owners[rightIndex];
      if (right === undefined || left.childKey === right.childKey) {
        continue;
      }
      if (isSameOrDescendant(left.path, right.path) || isSameOrDescendant(right.path, left.path)) {
        fail("別child間のownershipが重複しています");
      }
    }
  }

  for (const root of scopeRoots) {
    const coveringChildren = new Set(
      owners.filter((owner) => isSameOrDescendant(root, owner.path)).map((owner) => owner.childKey),
    );
    if (coveringChildren.size !== 1) {
      fail("scopeRootはexactly one childに被覆される必要があります");
    }
  }
}

function assertIntegrationGate(children: FanoutPlanChild[], requiredChildren: string[]): void {
  assertNoDuplicates(requiredChildren, "requiredChildren");
  const childKeys = children.map((child) => child.key).sort(compareText);
  const required = [...requiredChildren].sort(compareText);
  if (JSON.stringify(childKeys) !== JSON.stringify(required)) {
    fail("integrationGateは全childをexactly once参照する必要があります");
  }
  for (const child of children) {
    const spec = `${child.title}\n${child.body}`;
    if (containsForbiddenGitOperation(spec) || FORBIDDEN_CONFLICT_INSTRUCTION.test(spec)) {
      fail("child specにworker向けmerge/main操作が含まれています");
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareText);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return fail("canonical JSONへ変換できない値があります");
  }
  return encoded;
}

/** schema・path・DAG・coverageを検証し、決定論的planとhashを生成するpure関数。 */
export function createFanoutPlan(rawInput: unknown): FanoutPlanResult {
  const input = parseInput(rawInput);
  assertNoSecretLikeValues(input);
  if (input.parentSnapshot.taskId !== input.parentTaskId) {
    fail("parentSnapshot.taskIdがparentTaskIdと一致しません");
  }
  const repoCommonDir = canonicalAbsolutePath(input.repoCommonDir, "repoCommonDir");
  const scopeRoots = uniqueSorted(input.scopeRoots.map(canonicalRelativePath));
  const children = input.children.map((child) => ({
    ...child,
    worktree: canonicalWorktree(child.worktree),
    ownership: uniqueSorted(child.ownership.map(canonicalRelativePath)),
    dependsOn: [...child.dependsOn].sort(compareText),
  }));
  assertChildKeys(children);
  assertAcyclic(children);
  if (new Set(children.map((child) => child.worktree)).size !== children.length) {
    fail("child worktreeは相互に一意である必要があります");
  }
  assertOwnership(scopeRoots, children);
  assertIntegrationGate(children, input.integrationGate.requiredChildren);

  const canonicalChildren = [...children].sort((left, right) => compareText(left.key, right.key));
  const payload: CanonicalPlanPayload = {
    version: FANOUT_PLAN_VERSION,
    inputVersion: FANOUT_PLAN_INPUT_VERSION,
    parentTaskId: input.parentTaskId,
    parentSnapshot: { ...input.parentSnapshot },
    repoCommonDir,
    scopeRoots,
    children: canonicalChildren,
    integrationGate: {
      requiredChildren: [...input.integrationGate.requiredChildren].sort(compareText),
    },
  };
  const serialized = canonicalJson(payload);
  const planHash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return {
    plan: { ...payload, planHash },
    canonicalJson: serialized,
    planHash,
  };
}
