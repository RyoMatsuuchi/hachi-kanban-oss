// ワーカー子プロセスの資源ハイジーン用ユーティリティ（docs/contract.md §51）。
// supervisor reap と CLI doctor の双方から使うため core に置くが、DB 書き込みや実 kill は持たない。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** ps 由来のプロセス行。command は pgrep -f 相当の照合に使うため args/command 相当を優先する。 */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  etime: string;
  startTime: string;
  command: string;
}

export interface ProcessSubtree {
  root: ProcessEntry;
  pids: number[];
}

export interface BridgeProcessHygieneReport {
  bridgeDescendantCount: number;
  orphanCount: number;
  targets: ProcessSubtree[];
  appServerPids: number[];
  codexRootPids: number[];
  failOpenReason: string;
}

export interface DirectSessionProcessRecord {
  pid: number;
  exitExists: boolean;
}

export type ProcessListProvider = () => Promise<ProcessEntry[]>;
export type ProcessSignal = NodeJS.Signals | 0;
export type ProcessSignalSender = (pid: number, signal: ProcessSignal) => Promise<void> | void;

const APP_SERVER_MARKER = "kanban-shared-app-server";
const CODEX_MARKER = "codex";
const CODEX_APP_SERVER_MARKER = "app-server";

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** ps の etime（dd-hh:mm:ss / hh:mm:ss / mm:ss）を秒へ変換する。不正値は null。 */
export function parseEtimeSeconds(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(?:(\d+)-)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (match === null) {
    return null;
  }

  const days = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  const first = Number.parseInt(match[2]!, 10);
  const second = Number.parseInt(match[3]!, 10);
  const third = match[4] === undefined ? null : Number.parseInt(match[4], 10);

  if (second > 59 || (third !== null && third > 59)) {
    return null;
  }

  if (third === null) {
    return days * 86400 + first * 60 + second;
  }
  return days * 86400 + first * 3600 + second * 60 + third;
}

function parsePsLine(line: string): ProcessEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") {
    return null;
  }
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const pid = Number.parseInt(match[1]!, 10);
  const ppid = Number.parseInt(match[2]!, 10);
  const pgid = Number.parseInt(match[3]!, 10);
  if (!isPositiveInt(pid) || !Number.isSafeInteger(ppid) || ppid < 0 || !isPositiveInt(pgid)) {
    return null;
  }
  return { pid, ppid, pgid, etime: match[4]!, startTime: match[5]!, command: match[6]!.trim() };
}

/** 実環境用の ps 走査。テストでは ProcessListProvider を注入する。 */
export async function listSystemProcesses(): Promise<ProcessEntry[]> {
  const result = await execFileAsync("ps", ["-eo", "pid=,ppid=,pgid=,etime=,lstart=,args="], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout
    .split("\n")
    .map((line) => parsePsLine(line))
    .filter((entry): entry is ProcessEntry => entry !== null);
}

function commandIncludes(entry: ProcessEntry, marker: string): boolean {
  return entry.command.includes(marker);
}

function childrenByParent(processes: readonly ProcessEntry[]): Map<number, ProcessEntry[]> {
  const children = new Map<number, ProcessEntry[]>();
  for (const processEntry of processes) {
    const list = children.get(processEntry.ppid) ?? [];
    list.push(processEntry);
    children.set(processEntry.ppid, list);
  }
  return children;
}

function descendantsOf(rootPid: number, children: Map<number, ProcessEntry[]>): ProcessEntry[] {
  const result: ProcessEntry[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop()!;
    result.push(current);
    stack.push(...(children.get(current.pid) ?? []));
  }
  return result;
}

function depthFromRoot(pid: number, rootPid: number, byPid: Map<number, ProcessEntry>): number {
  let depth = 0;
  let current = byPid.get(pid);
  while (current !== undefined && current.pid !== rootPid) {
    depth += 1;
    current = byPid.get(current.ppid);
  }
  return depth;
}

function subtreePids(
  root: ProcessEntry,
  children: Map<number, ProcessEntry[]>,
  byPid: Map<number, ProcessEntry>,
  protectedPids: ReadonlySet<number>,
): number[] {
  const entries = [root, ...descendantsOf(root.pid, children)];
  // 子孫を先に signal し、親だけが先に消えて孫が残るケースを減らす。
  return entries
    .filter((entry) => !protectedPids.has(entry.pid))
    .sort((a, b) => depthFromRoot(b.pid, root.pid, byPid) - depthFromRoot(a.pid, root.pid, byPid))
    .map((entry) => entry.pid);
}

function hasCandidateAncestor(candidate: ProcessEntry, candidatePids: ReadonlySet<number>, byPid: Map<number, ProcessEntry>): boolean {
  let current = byPid.get(candidate.ppid);
  while (current !== undefined) {
    if (candidatePids.has(current.pid)) {
      return true;
    }
    current = byPid.get(current.ppid);
  }
  return false;
}

export function evaluateBridgeProcessHygiene(
  processes: readonly ProcessEntry[],
  maxRunSeconds: number,
  limit: number,
): BridgeProcessHygieneReport {
  const appServers = processes.filter((entry) => commandIncludes(entry, APP_SERVER_MARKER));
  if (appServers.length === 0) {
    return {
      bridgeDescendantCount: 0,
      orphanCount: 0,
      targets: [],
      appServerPids: [],
      codexRootPids: [],
      failOpenReason: "app-server-not-found",
    };
  }

  const appServerPids = new Set(appServers.map((entry) => entry.pid));
  const codexRoots = processes.filter((entry) => appServerPids.has(entry.ppid) && commandIncludes(entry, CODEX_MARKER));
  if (codexRoots.length === 0) {
    return {
      bridgeDescendantCount: 0,
      orphanCount: 0,
      targets: [],
      appServerPids: [...appServerPids],
      codexRootPids: [],
      failOpenReason: "codex-root-not-found",
    };
  }

  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const children = childrenByParent(processes);
  const codexRootPids = new Set(codexRoots.map((entry) => entry.pid));
  const protectedPids = new Set<number>([...appServerPids, ...codexRootPids]);
  const codexAppServers = processes.filter(
    (entry) => commandIncludes(entry, CODEX_MARKER) && commandIncludes(entry, CODEX_APP_SERVER_MARKER),
  );
  for (const appServer of codexAppServers) {
    protectedPids.add(appServer.pid);
    for (const descendant of descendantsOf(appServer.pid, children)) {
      protectedPids.add(descendant.pid);
    }
  }
  const thresholdSeconds = maxRunSeconds + 1800;
  const bridgeDescendants = codexRoots.flatMap((root) => descendantsOf(root.pid, children));
  const candidateRoots = bridgeDescendants.filter((entry) => {
    if (protectedPids.has(entry.pid)) {
      return false;
    }
    const ageSeconds = parseEtimeSeconds(entry.etime);
    return ageSeconds !== null && ageSeconds > thresholdSeconds;
  });
  const candidatePidSet = new Set(candidateRoots.map((entry) => entry.pid));
  const topLevelCandidates = candidateRoots.filter((entry) => !hasCandidateAncestor(entry, candidatePidSet, byPid));
  const limited = topLevelCandidates.slice(0, limit);

  return {
    bridgeDescendantCount: bridgeDescendants.length,
    orphanCount: topLevelCandidates.length,
    targets: limited.map((root) => ({ root, pids: subtreePids(root, children, byPid, protectedPids) })),
    appServerPids: [...appServerPids],
    codexRootPids: [...codexRootPids],
    failOpenReason: "",
  };
}

export function countDirectResidualGroups(
  processes: readonly ProcessEntry[],
  sessions: readonly DirectSessionProcessRecord[],
): number {
  return sessions.filter(
    (session) => session.exitExists && processes.some((entry) => entry.pgid === session.pid),
  ).length;
}

/** 実環境用の signal 送付。ESRCH は「既に消えた」とみなして無視する。 */
export function signalProcess(pid: number, signal: ProcessSignal): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" || signal === 0) {
      throw err;
    }
  }
}
