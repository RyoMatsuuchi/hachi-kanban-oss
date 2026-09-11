import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createProcessStdinReader,
  createSuccessorAttestationHashProbe,
  createSuccessorTmuxReadback,
  type SuccessorAttestationCommandRunner,
  unconfiguredSuccessorAttestationHashProbe,
} from "./successor-attestation.js";

const FIELD_SEPARATOR = "\u001f";
const SOCKET_PATH = "/tmp/tmux-501/default";
const SERVER_PID = 50_001;
const SERVER_START = "Thu Aug 27 10:11:12 2026";
const SERVER_START_SECONDS = Math.floor(Date.parse(SERVER_START) / 1_000);
const SERVER_LIFETIME_NONCE = "a".repeat(43);
const SERVER_LIFETIME_HASH = createHash("sha256")
  .update(`hachi-tmux-server-lifetime-v1\0${SOCKET_PATH}\0${SERVER_LIFETIME_NONCE}`)
  .digest("hex");

interface CommandCall {
  command: "tmux" | "ps";
  args: readonly string[];
}

function tmuxSnapshot(overrides: Partial<{
  session: string;
  pane: string;
  pid: string;
  cwd: string;
  owner: string;
  socketPath: string;
  serverPid: string;
}> = {}): string {
  return [
    overrides.session ?? "successor-session",
    overrides.pane ?? "%42",
    overrides.pid ?? "42001",
    overrides.cwd ?? "/repo/successor",
    overrides.owner ?? "owner-nonce",
    overrides.socketPath ?? SOCKET_PATH,
    overrides.serverPid ?? String(SERVER_PID),
  ].join(FIELD_SEPARATOR) + "\n";
}

function stableReadbackOutputs(overrides: Partial<{
  beforeNonce: string;
  afterNonce: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  serverStartBefore: string;
  serverStartAfter: string;
}> = {}): Array<string | Error> {
  return [
    overrides.beforeSnapshot ?? tmuxSnapshot(),
    `${overrides.beforeNonce ?? SERVER_LIFETIME_NONCE}\n`,
    `${overrides.serverStartBefore ?? SERVER_START}\n`,
    "42101\n",
    `${overrides.serverStartAfter ?? SERVER_START}\n`,
    `${overrides.afterNonce ?? SERVER_LIFETIME_NONCE}\n`,
    overrides.afterSnapshot ?? tmuxSnapshot(),
  ];
}

function createCommandRunner(outputs: readonly (string | Error)[]): {
  runner: SuccessorAttestationCommandRunner;
  calls: CommandCall[];
} {
  const queue = [...outputs];
  const calls: CommandCall[] = [];
  return {
    calls,
    runner: {
      run(command: "tmux" | "ps", args: readonly string[]): string {
        calls.push({ command, args });
        const output = queue.shift();
        if (output === undefined) throw new Error("未定義の subprocess 呼び出しです");
        if (output instanceof Error) throw output;
        return output;
      },
    },
  };
}

describe("Codex successor attestation production adapter", () => {
  it("tmux display→ps→tmux再readbackの安定したexact identityだけを返す", () => {
    const command = createCommandRunner(stableReadbackOutputs());
    const readback = createSuccessorTmuxReadback(command.runner, (path) => path).readExactPane("%42");

    expect(readback).toEqual({
      ok: true,
      value: {
        tmuxSession: "successor-session",
        tmuxPane: "%42",
        panePid: 42_001,
        processGroupId: 42_101,
        cwd: "/repo/successor",
        ownerNonce: "owner-nonce",
        tmuxSocketPath: SOCKET_PATH,
        tmuxServerPid: SERVER_PID,
        tmuxServerStartTime: SERVER_START_SECONDS,
        tmuxServerLifetimeHash: SERVER_LIFETIME_HASH,
      },
    });
    expect(command.calls.map((call) => call.command)).toEqual([
      "tmux", "tmux", "ps", "ps", "ps", "tmux", "tmux",
    ]);
    expect(command.calls[0]?.args).toEqual([
      "display-message",
      "-p",
      "-t",
      "%42",
      "-F",
      `#{session_name}${FIELD_SEPARATOR}#{pane_id}${FIELD_SEPARATOR}` +
        `#{pane_pid}${FIELD_SEPARATOR}#{pane_current_path}${FIELD_SEPARATOR}` +
        `#{@hachi_handoff_owner}${FIELD_SEPARATOR}#{socket_path}${FIELD_SEPARATOR}#{pid}`,
    ]);
    expect(command.calls[1]?.args).toEqual([
      "show-options", "-s", "-v", "@hachi_runtime_lifetime_v1",
    ]);
    expect(command.calls[2]?.args).toEqual(["-p", String(SERVER_PID), "-o", "lstart="]);
    expect(command.calls[3]?.args).toEqual(["-o", "pgid=", "-p", "42001"]);
    expect(command.calls[6]?.args).toEqual(command.calls[0]?.args);
  });

  it.each([
    ["pane PID drift", stableReadbackOutputs({ afterSnapshot: tmuxSnapshot({ pid: "42002" }) })],
    ["owner drift", stableReadbackOutputs({ afterSnapshot: tmuxSnapshot({ owner: "other-owner" }) })],
    ["tmux parse failure", ["broken\n"]],
    ["tmux複数行", [`${tmuxSnapshot()}unexpected\n`]],
    ["ps parse failure", [tmuxSnapshot(), `${SERVER_LIFETIME_NONCE}\n`, `${SERVER_START}\n`, "not-a-pgid\n"]],
  ] as const)("%s は authority 0 を返す", (_label, outputs) => {
    const command = createCommandRunner(outputs);
    expect(createSuccessorTmuxReadback(command.runner, (path) => path).readExactPane("%42"))
      .toEqual({ ok: false, reason: "unavailable" });
  });

  it("bind producerはset-option -s -o競合後にwinning nonceを再読取しraw値を返さない", () => {
    const winningNonce = "w".repeat(43);
    const expectedHash = createHash("sha256")
      .update(`hachi-tmux-server-lifetime-v1\0${SOCKET_PATH}\0${winningNonce}`)
      .digest("hex");
    const command = createCommandRunner([
      new Error("option already set"),
      ...stableReadbackOutputs({ beforeNonce: winningNonce, afterNonce: winningNonce }),
    ]);
    const result = createSuccessorTmuxReadback(command.runner, (path) => path)
      .initializeServerLifetimeAndReadExactPane("%42", "c".repeat(43));

    expect(command.calls[0]?.args).toEqual([
      "set-option", "-s", "-o", "@hachi_runtime_lifetime_v1", "c".repeat(43),
    ]);
    expect(result).toMatchObject({
      ok: true,
      value: { tmuxServerLifetimeHash: expectedHash },
    });
    expect(JSON.stringify(result)).not.toContain(winningNonce);
  });

  it.each([
    ["missing", [tmuxSnapshot(), "\n"], "missing"],
    ["malformed", [tmuxSnapshot(), "not-256-bit\n"], "malformed"],
    [
      "raw nonce whitespace drift",
      stableReadbackOutputs({ afterNonce: ` ${SERVER_LIFETIME_NONCE} ` }),
      "malformed",
    ],
    ["nonce drift", stableReadbackOutputs({ afterNonce: "b".repeat(43) }), "drift"],
    [
      "server restart",
      stableReadbackOutputs({
        afterSnapshot: tmuxSnapshot({ serverPid: String(SERVER_PID + 1), owner: "" }),
      }),
      "drift",
    ],
  ] as const)("server lifetime %s は分類済みauthority 0を返す", (_label, outputs, reason) => {
    const command = createCommandRunner(outputs);
    expect(createSuccessorTmuxReadback(command.runner, (path) => path).readExactPane("%42"))
      .toEqual({ ok: false, reason });
  });

  it("同じpane IDもserver restart後は新しいlifetime hashとしてreadbackする", () => {
    const firstNonce = "x".repeat(43);
    const secondNonce = "y".repeat(43);
    const first = createCommandRunner(stableReadbackOutputs({
      beforeNonce: firstNonce,
      afterNonce: firstNonce,
    }));
    const second = createCommandRunner(stableReadbackOutputs({
      beforeNonce: secondNonce,
      afterNonce: secondNonce,
      beforeSnapshot: tmuxSnapshot({ serverPid: String(SERVER_PID + 1) }),
      afterSnapshot: tmuxSnapshot({ serverPid: String(SERVER_PID + 1) }),
    }));

    const firstResult = createSuccessorTmuxReadback(first.runner, (path) => path).readExactPane("%42");
    const secondResult = createSuccessorTmuxReadback(second.runner, (path) => path).readExactPane("%42");

    expect(firstResult.ok).toBe(true);
    expect(secondResult.ok).toBe(true);
    if (!firstResult.ok || !secondResult.ok) throw new Error("stable readback fixture が不正です");
    expect(firstResult.value.tmuxPane).toBe(secondResult.value.tmuxPane);
    expect(firstResult.value.tmuxServerLifetimeHash).not.toBe(secondResult.value.tmuxServerLifetimeHash);
    expect(first.calls.some((call) => call.args[0] === "set-option")).toBe(false);
    expect(second.calls.some((call) => call.args[0] === "set-option")).toBe(false);
  });

  it("streaming stdin はchunk累計のUTF-8 byte上限を超えた時点で拒否する", async () => {
    const stream = Readable.from([Buffer.from("1234"), Buffer.from("あ")]);
    const reader = createProcessStdinReader(stream);
    await expect(reader.read(6)).rejects.toThrow("6 bytes 以下");
  });

  it("Gate 4 resolverが渡す実file bytesをそれぞれSHA-256する", () => {
    const dir = mkdtempSync(join(tmpdir(), "hachi-attestation-hash-"));
    try {
      const hookPath = join(dir, "session-start-hook.json");
      const helperPath = join(dir, "hachi-attest-helper");
      const hookBytes = Buffer.from("reviewed-hook-definition\n");
      const helperBytes = Buffer.from("reviewed-helper-entrypoint\n");
      writeFileSync(hookPath, hookBytes);
      writeFileSync(helperPath, helperBytes);

      expect(createSuccessorAttestationHashProbe(hookPath, helperPath).readInstalledHashes()).toEqual({
        hookDefinitionHash: createHash("sha256").update(hookBytes).digest("hex"),
        hookExecutableHash: createHash("sha256").update(helperBytes).digest("hex"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Gate 4 publication前のproduction hash probeはartifactを推測せずfail-closed", () => {
    expect(() => unconfiguredSuccessorAttestationHashProbe.readInstalledHashes())
      .toThrow("Gate 4 publication 前のため未構成");
  });
});
