import { describe, expect, it } from "vitest";
import type { RuntimeResourceMemberRow } from "@hachi/core";
import { SystemRuntimeResourceInspector, type RuntimeResourceCommandRunner } from "./resource-inspector.js";

function member(kind: RuntimeResourceMemberRow["kind"]): RuntimeResourceMemberRow {
  return {
    id: "rm_test",
    leaseId: "rl_test",
    kind,
    state: "active",
    cleanupPolicy: "auto",
    managed: true,
    ephemeral: true,
    objectFence: 2,
    scopeKey: kind === "tcp_port" ? "host:local" : "docker:desktop-linux",
    nativeId: kind === "tcp_port" ? "pid:42:start:100:port:43123" : "container-1",
    displayName: "preview",
    hostIp: "127.0.0.1",
    hostPort: kind === "tcp_port" ? 43123 : null,
    containerPort: kind === "tcp_port" ? 3000 : null,
    composeProject: "preview-project",
    labelsHash: "a".repeat(64),
    provenance: "{}",
    provenanceVerifiedAt: null,
    lastObservedAt: 100,
    releasedAt: null,
    createdAt: 100,
    updatedAt: 100,
  };
}

class FakeRunner implements RuntimeResourceCommandRunner {
  readonly calls: Array<{ command: string; args: readonly string[] }> = [];

  run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, args });
    if (command === "docker" && args[0] === "inspect" && args[2] === "container") {
      return Promise.resolve({
        stdout: JSON.stringify([{
          Id: "container-1",
          Name: "/preview",
          Config: { Labels: { "com.docker.compose.project": "preview-project", "com.docker.compose.service": "web" } },
          NetworkSettings: {
            Ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43123" }] },
            Networks: { default: { NetworkID: "network-1" } },
          },
        }]),
        stderr: "",
      });
    }
    if (command === "lsof" && args[0] === "-nP") {
      return Promise.resolve({ stdout: "p42\ncpreview\n", stderr: "" });
    }
    if (command === "ps") {
      return Promise.resolve({ stdout: "Fri Jul 10 10:00:00 2026\n", stderr: "" });
    }
    if (command === "lsof" && args[0] === "-a") {
      return Promise.resolve({ stdout: "fcwd\nn/tmp/preview-worktree\n", stderr: "" });
    }
    if (command === "docker" && args[0] === "context") {
      return Promise.resolve({ stdout: "desktop-linux\n", stderr: "" });
    }
    if (command === "docker" && args[0] === "network" && args[1] === "ls") {
      return Promise.resolve({ stdout: `${JSON.stringify({ ID: "network-lega", Name: "legacy", Driver: "bridge", Scope: "local" })}\n`, stderr: "" });
    }
    if (command === "docker" && args[0] === "network" && args[1] === "inspect") {
      return Promise.resolve({
        stdout: JSON.stringify([{
          Id: "network-legacy-full-id",
          Name: "legacy",
          Driver: "bridge",
          Scope: "local",
          Labels: {},
          Containers: { "container-a": {} },
          IPAM: { Config: [{ Subnet: "172.28.0.0/16" }] },
        }]),
        stderr: "",
      });
    }
    return Promise.reject(new Error(`unexpected command: ${command} ${args.join(" ")}`));
  }
}

describe("SystemRuntimeResourceInspector", () => {
  it("container の compose project/service・published port・network attachment を read-only 抽出する", async () => {
    const inspector = new SystemRuntimeResourceInspector(new FakeRunner());
    const inspection = await inspector.inspectMember(member("docker_container"));

    expect(inspection).toMatchObject({
      available: true,
      docker: {
        objectId: "container-1",
        composeProject: "preview-project",
        composeService: "web",
        publishedPorts: [{ hostIp: "127.0.0.1", hostPort: 43123, containerPort: 3000 }],
        attachedNetworkIds: ["network-1"],
      },
    });
  });

  it("64hex の Docker full object ID を内部照合用にそのまま保持する", async () => {
    const objectId = "0123456789abcdef".repeat(4);
    const runner = new FakeRunner();
    runner.run = (command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
      runner.calls.push({ command, args });
      if (command === "docker" && args[0] === "inspect" && args[2] === "container") {
        return Promise.resolve({
          stdout: JSON.stringify([{
            Id: objectId,
            Name: "/postgres",
            Config: { Labels: {} },
            NetworkSettings: { Ports: {}, Networks: {} },
          }]),
          stderr: "",
        });
      }
      return Promise.reject(new Error(`unexpected command: ${command} ${args.join(" ")}`));
    };
    const container = { ...member("docker_container"), nativeId: objectId };
    const inspector = new SystemRuntimeResourceInspector(runner);

    const inspection = await inspector.inspectMember(container);

    expect(inspection.docker?.objectId).toBe(objectId);
    expect(runner.calls).toContainEqual({
      command: "docker",
      args: ["inspect", "--type", "container", objectId],
    });
  });

  it("tcp port の listener PID/start time/cwd を read-only 抽出する", async () => {
    const inspector = new SystemRuntimeResourceInspector(new FakeRunner());
    const inspection = await inspector.inspectMember(member("tcp_port"));

    expect(inspection).toMatchObject({
      available: true,
      portOwner: { pid: 42, startTime: "Fri Jul 10 10:00:00 2026", cwd: "/tmp/preview-worktree" },
    });
  });

  it("listener 不在は inspection unavailable ではなく、available な不在として返す", async () => {
    const runner = new FakeRunner();
    runner.run = (command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode?: number }> => {
      runner.calls.push({ command, args });
      if (command === "lsof" && args[0] === "-nP") {
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
      }
      return Promise.reject(new Error(`unexpected command: ${command} ${args.join(" ")}`));
    };
    const inspector = new SystemRuntimeResourceInspector(runner);

    await expect(inspector.inspectMember(member("tcp_port"))).resolves.toMatchObject({
      available: true,
      error: "",
      portOwner: null,
    });
  });

  it("同一portの複数listener PIDを全件保持する", async () => {
    const runner = new FakeRunner();
    runner.run = (command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode?: number }> => {
      runner.calls.push({ command, args });
      if (command === "lsof" && args[0] === "-nP") {
        return Promise.resolve({ stdout: "p42\np99\n", stderr: "", exitCode: 0 });
      }
      if (command === "ps") {
        return Promise.resolve({ stdout: args[1] === "42" ? "100\n" : "200\n", stderr: "" });
      }
      if (command === "lsof" && args[0] === "-a") {
        return Promise.resolve({ stdout: `fcwd\nn/tmp/${args[2]}\n`, stderr: "" });
      }
      return Promise.reject(new Error(`unexpected command: ${command} ${args.join(" ")}`));
    };
    const inspector = new SystemRuntimeResourceInspector(runner);

    await expect(inspector.inspectMember(member("tcp_port"))).resolves.toMatchObject({
      available: true,
      portOwner: { pid: 42 },
      portOwners: [{ pid: 42, startTime: "100" }, { pid: 99, startTime: "200" }],
    });
  });

  it("Docker network inventory は legacy object を観測するだけで mutator を呼ばない", async () => {
    const runner = new FakeRunner();
    const inspector = new SystemRuntimeResourceInspector(runner);
    const inventory = await inspector.inventory();

    expect(inventory).toMatchObject({
      available: true,
      dockerContext: "desktop-linux",
      networks: [{ nativeId: "network-legacy-full-id", attachedNativeIds: ["container-a"], subnets: ["172.28.0.0/16"] }],
    });
    expect(runner.calls.every((call) => !["rm", "stop", "kill", "prune", "down"].includes(call.args[0] ?? ""))).toBe(true);
  });

  it("Docker network inspect が一部失敗した inventory を利用可能として扱わない", async () => {
    const runner = new FakeRunner();
    runner.run = (command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
      runner.calls.push({ command, args });
      if (command === "docker" && args[0] === "context") {
        return Promise.resolve({ stdout: "desktop-linux\n", stderr: "" });
      }
      if (command === "docker" && args[0] === "network" && args[1] === "ls") {
        return Promise.resolve({ stdout: `${JSON.stringify({ ID: "network-missing", Name: "missing", Driver: "bridge", Scope: "local" })}\n`, stderr: "" });
      }
      if (command === "docker" && args[0] === "network" && args[1] === "inspect") {
        return Promise.reject(new Error("network disappeared"));
      }
      return Promise.reject(new Error(`unexpected command: ${command} ${args.join(" ")}`));
    };
    const inspector = new SystemRuntimeResourceInspector(runner);

    await expect(inspector.inventory()).resolves.toMatchObject({
      available: false,
      networks: [],
      inspectionErrors: [expect.stringContaining("network-missing")],
    });
  });
});
