// =============================================================================
// Runtime resource の read-only host inspection。
// Docker/OS に対して create/remove/stop/kill/relabel を一切発行せず、一覧・doctor の根拠だけを返す。
// =============================================================================

import { execFile } from "node:child_process";
import { redactText, type RuntimeResourceMemberRow } from "@hachi/core";

export interface RuntimePortOwner {
  pid: number;
  startTime: string;
  cwd: string;
}

export interface RuntimePublishedPort {
  hostIp: string;
  hostPort: number | null;
  containerPort: number | null;
}

export interface RuntimeDockerMetadata {
  objectId: string;
  name: string;
  composeProject: string;
  composeService: string;
  publishedPorts: RuntimePublishedPort[];
  attachedNetworkIds: string[];
  subnets: string[];
}

export interface RuntimeMemberInspection {
  memberId: string;
  available: boolean;
  error: string;
  portOwner: RuntimePortOwner | null;
  /** 同一portにwildcard/specific bindが共存する場合を含む、観測した全listener owner。 */
  portOwners?: RuntimePortOwner[];
  docker: RuntimeDockerMetadata | null;
}

export interface RuntimeNetworkInventoryEntry {
  nativeId: string;
  displayName: string;
  driver: string;
  scope: string;
  composeProject: string;
  composeService: string;
  attachedNativeIds: string[];
  subnets: string[];
  hachiManaged: boolean;
}

export interface RuntimeResourceInventory {
  available: boolean;
  error: string;
  inspectionErrors: string[];
  dockerContext: string;
  networks: RuntimeNetworkInventoryEntry[];
}

/** CLI の host probe を差し替えるための read-only 境界。 */
export interface RuntimeResourceInspector {
  inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection>;
  inventory(): Promise<RuntimeResourceInventory>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface RuntimeResourceCommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult>;
}

class SystemCommandRunner implements RuntimeResourceCommandRunner {
  run(command: string, args: readonly string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error !== null) {
          // lsof は該当 listener が無いときに exit 1 を返す。これは probe 成功かつ
          // listener 不在を示すため、呼び出し側で inspection unavailable と区別する。
          if (command === "lsof" && error.code === 1) {
            resolve({ stdout, stderr, exitCode: 1 });
            return;
          }
          reject(new Error(redactText(`${command}: ${stderr || error.message}`)));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      });
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  return asRecord(asRecord(value)?.[key]) ?? {};
}

function arrayField(value: unknown, key: string): unknown[] {
  const candidate = asRecord(value)?.[key];
  return Array.isArray(candidate) ? candidate : [];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("read-only inspection の JSON 解析に失敗しました");
  }
}

function parseFirstDockerDocument(stdout: string): Record<string, unknown> {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Docker inspect の応答形状が不正です");
  }
  const document = asRecord(parsed[0]);
  if (document === null) {
    throw new Error("Docker inspect の object 形状が不正です");
  }
  return document;
}

function parsePortFromKey(key: string): number | null {
  const match = /^(\d+)\/(?:tcp|udp)$/.exec(key);
  return match === null ? null : Number.parseInt(match[1] ?? "", 10);
}

function parseDockerMetadata(document: Record<string, unknown>, network: boolean): RuntimeDockerMetadata {
  const labels = objectField(document, "Config");
  const configLabels = asRecord(labels.Labels) ?? asRecord(document.Labels) ?? {};
  const composeProject = stringField(configLabels["com.docker.compose.project"]);
  const composeService = stringField(configLabels["com.docker.compose.service"]);
  const objectId = stringField(document.Id);
  const name = stringField(document.Name).replace(/^\//, "");
  const publishedPorts: RuntimePublishedPort[] = [];
  const attachedNetworkIds: string[] = [];
  const subnets: string[] = [];

  if (network) {
    const containers = objectField(document, "Containers");
    for (const nativeId of Object.keys(containers).sort()) {
      attachedNetworkIds.push(nativeId);
    }
    const ipam = objectField(document, "IPAM");
    for (const config of arrayField(ipam, "Config")) {
      const subnet = stringField(asRecord(config)?.Subnet);
      if (subnet !== "") {
        subnets.push(subnet);
      }
    }
  } else {
    const networkSettings = objectField(document, "NetworkSettings");
    const ports = objectField(networkSettings, "Ports");
    for (const [key, mappings] of Object.entries(ports)) {
      if (!Array.isArray(mappings)) {
        continue;
      }
      for (const mapping of mappings) {
        const value = asRecord(mapping);
        if (value === null) {
          continue;
        }
        const parsedPort = stringField(value.HostPort);
        publishedPorts.push({
          hostIp: stringField(value.HostIp),
          hostPort: /^\d+$/.test(parsedPort) ? Number.parseInt(parsedPort, 10) : null,
          containerPort: parsePortFromKey(key),
        });
      }
    }
    const networks = objectField(networkSettings, "Networks");
    for (const attachment of Object.values(networks)) {
      const networkId = stringField(asRecord(attachment)?.NetworkID);
      if (networkId !== "") {
        attachedNetworkIds.push(networkId);
      }
    }
  }

  return {
    objectId,
    name,
    composeProject,
    composeService,
    publishedPorts,
    attachedNetworkIds: [...new Set(attachedNetworkIds)].sort(),
    subnets: [...new Set(subnets)].sort(),
  };
}

function parseListenerPids(stdout: string): number[] {
  const pids = new Set<number>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("p")) {
      continue;
    }
    const candidate = line.slice(1);
    if (/^[1-9][0-9]*$/.test(candidate)) {
      pids.add(Number.parseInt(candidate, 10));
    }
  }
  return [...pids].sort((left, right) => left - right);
}

function parseCwd(stdout: string): string {
  const match = /(?:^|\n)f(?:cwd)?\n?n([^\n]+)/.exec(stdout);
  return match?.[1] === undefined ? "" : redactText(match[1]);
}

/** 実機では Docker CLI / lsof / ps だけを read-only で実行する。 */
export class SystemRuntimeResourceInspector implements RuntimeResourceInspector {
  private readonly runner: RuntimeResourceCommandRunner;

  constructor(runner: RuntimeResourceCommandRunner = new SystemCommandRunner()) {
    this.runner = runner;
  }

  async inspectMember(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
    try {
      if (member.kind === "tcp_port") {
        return await this.inspectPort(member);
      }
      if (member.kind === "docker_container" || member.kind === "docker_network") {
        const type = member.kind === "docker_container" ? "container" : "network";
        const result = await this.runner.run("docker", ["inspect", "--type", type, member.nativeId]);
        const docker = parseDockerMetadata(parseFirstDockerDocument(result.stdout), member.kind === "docker_network");
        return { memberId: member.id, available: true, error: "", portOwner: null, docker };
      }
      return { memberId: member.id, available: true, error: "", portOwner: null, docker: null };
    } catch (err) {
      return {
        memberId: member.id,
        available: false,
        error: redactText(err instanceof Error ? err.message : String(err)),
        portOwner: null,
        docker: null,
      };
    }
  }

  private async inspectPort(member: RuntimeResourceMemberRow): Promise<RuntimeMemberInspection> {
    if (member.hostPort === null) {
      return {
        memberId: member.id,
        available: false,
        error: "tcp_port member に hostPort がありません",
        portOwner: null,
        docker: null,
      };
    }
    try {
      const listener = await this.runner.run("lsof", ["-nP", `-iTCP:${member.hostPort}`, "-sTCP:LISTEN", "-Fpc"]);
      const pids = parseListenerPids(listener.stdout);
      if (listener.exitCode === 1 && (listener.stderr.trim() !== "" || pids.length > 0)) {
        throw new Error(redactText(`lsof: ${listener.stderr || "unexpected exit 1"}`));
      }
      if (pids.length === 0) {
        return { memberId: member.id, available: true, error: "", portOwner: null, portOwners: [], docker: null };
      }
      const owners = await Promise.all(pids.map(async (pid): Promise<RuntimePortOwner> => {
        const [processInfo, cwdInfo] = await Promise.all([
          this.runner.run("ps", ["-p", String(pid), "-o", "lstart="]),
          this.runner.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
        ]);
        return {
          pid,
          startTime: redactText(processInfo.stdout.trim()),
          cwd: parseCwd(cwdInfo.stdout),
        };
      }));
      return {
        memberId: member.id,
        available: true,
        error: "",
        portOwner: owners[0] ?? null,
        portOwners: owners,
        docker: null,
      };
    } catch (err) {
      return {
        memberId: member.id,
        available: false,
        error: redactText(err instanceof Error ? err.message : String(err)),
        portOwner: null,
        docker: null,
      };
    }
  }

  async inventory(): Promise<RuntimeResourceInventory> {
    try {
      const context = (await this.runner.run("docker", ["context", "show"])).stdout.trim();
      const listing = await this.runner.run("docker", ["network", "ls", "--format", "{{json .}}"]);
      const rows = listing.stdout.split("\n").filter((line) => line.trim() !== "");
      const networks: RuntimeNetworkInventoryEntry[] = [];
      const inspectionErrors: string[] = [];
      for (const line of rows) {
        const row = asRecord(parseJson(line));
        const listedId = stringField(row?.ID);
        if (listedId === "") {
          continue;
        }
        try {
          // `docker network ls` の ID は通常短縮形なので、exact object identity は inspect の完全 ID から得る。
          const inspected = await this.runner.run("docker", ["network", "inspect", listedId]);
          const document = parseFirstDockerDocument(inspected.stdout);
          const metadata = parseDockerMetadata(document, true);
          if (metadata.objectId === "") {
            inspectionErrors.push(`network ${listedId} の完全 ID を取得できません`);
            continue;
          }
          const labels = asRecord(document.Labels) ?? {};
          networks.push({
            nativeId: metadata.objectId,
            displayName: metadata.name || stringField(row?.Name),
            driver: stringField(document.Driver) || stringField(row?.Driver),
            scope: stringField(document.Scope) || stringField(row?.Scope),
            composeProject: metadata.composeProject,
            composeService: metadata.composeService,
            attachedNativeIds: metadata.attachedNetworkIds,
            subnets: metadata.subnets,
            hachiManaged: labels["io.hachi.managed"] === "true",
          });
        } catch (err) {
          inspectionErrors.push(redactText(
            `network ${listedId} inspect に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
          ));
        }
      }
      return {
        available: inspectionErrors.length === 0,
        error: inspectionErrors.join("; "),
        inspectionErrors,
        dockerContext: redactText(context),
        networks: networks.sort((left, right) => left.nativeId.localeCompare(right.nativeId)),
      };
    } catch (err) {
      return {
        available: false,
        error: redactText(err instanceof Error ? err.message : String(err)),
        inspectionErrors: [],
        dockerContext: "",
        networks: [],
      };
    }
  }
}
