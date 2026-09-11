import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATOR_SESSION_STALE_SECONDS,
  STEWARD_STATE_LOCK_GUARD_NAME,
  acquireStewardStateLock,
  createRuntimeProjectHostAdapterSnapshot,
  runtimeLabelsHash,
  runtimeResourcesSchema,
} from "@hachi/core";
import { MockBridgeServer } from "@hachi/testing";
import { resolveHermesHome } from "../deps.js";
import { buildProgram } from "../program.js";
import { SuccessorAttestationArtifactError } from "../successor-attestation-artifacts.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

interface DoctorCheckResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
  reason?: "offline" | "unused-transport" | "writer-not-deployed" | "bridge-not-running";
}

/** supervisor heartbeat ファイルを HOME 配下の state/ に書き込む（supervisor の書式を模す。docs/contract.md §33.1） */
function writeHeartbeat(home: string, ts: number): void {
  const dir = join(home, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "supervisor-heartbeat.json"),
    JSON.stringify({ ts, pid: 12345, tickCount: 1, intervalSec: 30 }),
    "utf8",
  );
}

/** steward 状態ファイルを HOME 配下の state/ に書き込む */
function writeStewardState(home: string, state: Record<string, unknown>): void {
  const dir = join(home, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "steward.json"), JSON.stringify(state), "utf8");
}

function writeBriefState(home: string, state: Record<string, unknown>): void {
  const dir = join(home, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "brief.json"), JSON.stringify(state), "utf8");
}

function passthroughPatchStatusPath(home: string): string {
  return join(home, "even-shared", "passthrough-patch-status.json");
}

function writePassthroughPatchStatus(home: string, status: Record<string, unknown>): void {
  const path = passthroughPatchStatusPath(home);
  mkdirSync(join(home, "even-shared"), { recursive: true });
  writeFileSync(path, JSON.stringify(status), { encoding: "utf8", mode: 0o600 });
}

function validPassthroughPatchStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "passthrough-patch-status/v1",
    state: "ok",
    patchVersion: "v6",
    evenTerminalVersion: "0.8.1",
    updatedAt: "2026-08-23T12:34:56.000Z",
    detail: "",
    bridgePid: 4_242,
    ...overrides,
  };
}

/** web healthz 用に「常に成功」の fetch モックを stub する（heartbeat 検査など他項目に注力するテスト用） */
function stubHealthyFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, taskCount: 0 }), { status: 200 })),
  );
}

describe("hachi doctor", () => {
  let ctx: TestDeps;

  beforeEach(() => {
    // ambient 環境の HACHI_KANBAN_WEB_PORT に left-over があってもテストが決定的になるよう毎回消す
    delete process.env.HACHI_KANBAN_WEB_PORT;
  });

  afterEach(() => {
    vi.useRealTimers();
    ctx.cleanup();
    vi.unstubAllGlobals();
    delete process.env.HACHI_KANBAN_WEB_PORT;
  });

  it("communication設定がある場合はruntime/version/config/native adapter readinessを表示する", async () => {
    ctx = createTestDeps();
    ctx.deps.config.communication = {
      codex: {
        rollout: "off",
        claimLeaseSeconds: 60,
        bindingTtlSeconds: 300,
      },
      claude: {
        rollout: "off",
        claimLeaseSeconds: 60,
        bindingTtlSeconds: 300,
      },
    };

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as {
      checks: Array<{ name: string; ok: boolean; detail: string }>;
      ok: boolean;
    };
    const check = result.checks.find((candidate) => candidate.name === "native communication readiness");
    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toContain("config=ok");
    expect(check?.detail).toContain("adapter=absent");
    expect(check?.detail).toContain("runtime=none");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("--offline: DB/config 検査は実行され bridge・supervisor heartbeat・web healthz 検査は呼ばれずスキップされる", async () => {
    ctx = createTestDeps();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "HACHI_KANBAN_HOME",
      "config.json",
      "DB",
      "verify directives",
      "codex successor attestation",
      "orchestrator routing",
      "runtime resource profiles",
      "runtime resource leases",
      "runtime resource cleanup",
      "web-token",
      "telegram-token",
      "codex bridge",
      "claude bridge",
      "passthrough patch status",
      "model transport (docs)",
      "model transport (implement)",
      "model transport (plan)",
      "model transport (review)",
      "supervisor heartbeat",
      "web healthz",
      "steward state",
      "steward state lock",
      "brief state",
      "worker process hygiene",
      "kill-switch",
      "log rotation",
      "handover preflight",
      "orchestrator helpers",
    ]);
    for (const check of result.checks) {
      expect(check.ok).toBe(true);
    }

    // bridge の healthCheck も web healthz の fetch も一切呼ばれていないこと（実ネットワークに出ない）
    expect(ctx.codexAdapter.healthCheckCalls).toBe(0);
    expect(ctx.claudeAdapter.healthCheckCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    for (const name of [
      "codex bridge",
      "claude bridge",
      "model transport (docs)",
      "model transport (implement)",
      "model transport (plan)",
      "model transport (review)",
      "supervisor heartbeat",
      "web healthz",
    ]) {
      const check = result.checks.find((candidate) => candidate.name === name);
      expect(check).toMatchObject({ ok: true, skipped: true, reason: "offline" });
      expect(check?.detail).toContain("readiness の証明ではありません");
    }
    expect(ctx.exitCodes).toEqual([]);
  });

  it("manual + manifest未配備はofflineでもmanual fallbackを明示してoverall OKにする", async () => {
    ctx = createTestDeps();
    ctx.deps.successorAttestationArtifactResolver = {
      readInstalledHashes: () => {
        throw new SuccessorAttestationArtifactError("manifest_missing", "manifest未配備");
      },
      resolveInstalledArtifacts: () => {
        throw new SuccessorAttestationArtifactError("manifest_missing", "manifest未配備");
      },
    };

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "codex successor attestation");
    expect(result.ok).toBe(true);
    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toContain("manual create_thread fallback");
    expect(check?.detail).toContain("readiness証明ではありません");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("enforce + manifest未配備とmanual + deployed driftはofflineでもNGにする", async () => {
    ctx = createTestDeps();
    ctx.deps.config.orchestrator = { codexSuccessorAttestation: { mode: "enforce" } };
    ctx.deps.successorAttestationArtifactResolver = {
      readInstalledHashes: () => {
        throw new SuccessorAttestationArtifactError("manifest_missing", "manifest未配備");
      },
      resolveInstalledArtifacts: () => {
        throw new SuccessorAttestationArtifactError("manifest_missing", "manifest未配備");
      },
    };
    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });
    let result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    expect(result.ok).toBe(false);
    expect(result.checks.find((candidate) => candidate.name === "codex successor attestation"))
      .toMatchObject({ ok: false, detail: "mode=enforce artifact検証NG reason=manifest_missing" });
    expect(ctx.exitCodes).toEqual([1]);

    ctx.stdout.clear();
    ctx.exitCodes.length = 0;
    ctx.deps.config.orchestrator = { codexSuccessorAttestation: { mode: "manual" } };
    ctx.deps.successorAttestationArtifactResolver = {
      readInstalledHashes: () => {
        throw new SuccessorAttestationArtifactError("hook_hash_mismatch", "secret-path/hash");
      },
      resolveInstalledArtifacts: () => {
        throw new SuccessorAttestationArtifactError("hook_hash_mismatch", "secret-path/hash");
      },
    };
    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });
    result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(serialized).toContain("reason=hook_hash_mismatch");
    expect(serialized).not.toContain("secret-path/hash");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("manual/enforceともexact artifact一致はdoctor OKにする", async () => {
    ctx = createTestDeps();
    const resolver = {
      readInstalledHashes: () => ({
        hookDefinitionHash: "a".repeat(64),
        hookExecutableHash: "b".repeat(64),
      }),
      resolveInstalledArtifacts: () => ({
        codexHome: "/redacted/codex-home",
        installedHooksPath: "/redacted/codex-home/hooks.json",
        helperExecutablePath: "/redacted/bin/hachi",
        hookDefinitionHash: "a".repeat(64),
        hookExecutableHash: "b".repeat(64),
      }),
    };
    ctx.deps.successorAttestationArtifactResolver = resolver;
    for (const mode of ["manual", "enforce"] as const) {
      ctx.deps.config.orchestrator = { codexSuccessorAttestation: { mode } };
      ctx.stdout.clear();
      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });
      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const serialized = JSON.stringify(result);
      expect(result.checks.find((candidate) => candidate.name === "codex successor attestation"))
        .toMatchObject({ ok: true, detail: `mode=${mode} static hook/helper exact一致` });
      expect(serialized).not.toContain("/redacted/");
      expect(serialized).not.toContain("a".repeat(64));
    }
    expect(ctx.exitCodes).toEqual([]);
  });

  it("passthrough patch status が ok なら version と updatedAt を表示する", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus());

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(true);
    expect(check).toEqual({
      name: "passthrough patch status",
      ok: true,
      detail: "patchVersion=v6 evenTerminalVersion=0.8.1 updatedAt=2026-08-23T12:34:56.000Z",
    });
    expect(ctx.exitCodes).toEqual([]);
  });

  it("passthrough patch status の state が ok 以外なら detail を1行1000字で切って NG にする", async () => {
    ctx = createTestDeps();
    const longDetail = `${"x".repeat(500)}\n${"y".repeat(499)}`;
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      state: "error",
      detail: longDetail,
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toBe(`state=error detail=${`${"x".repeat(500)} ${"y".repeat(499)}`}`);
    expect(check?.detail).not.toContain("\n");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status が error かつ patchVersion=null なら detail を表示して NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      state: "error",
      patchVersion: null,
      updatedAt: "2026-08-23T18:00:00Z",
      detail: "unknown hash; refusing bridge start",
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toEqual({
      name: "passthrough patch status",
      ok: false,
      detail: "state=error detail=unknown hash; refusing bridge start",
    });
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status が applying かつ patchVersion=null なら NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      state: "applying",
      patchVersion: null,
      detail: "patch apply is in progress",
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toEqual({
      name: "passthrough patch status",
      ok: false,
      detail: "state=applying detail=patch apply is in progress 数秒後に再実行してください",
    });
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の未知 state は NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({ state: "future" }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false, detail: "state=future detail=" });
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status が ok かつ patchVersion=null なら NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({ patchVersion: null }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("state=ok ですが patchVersion が null です");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の読み取りが ENOENT なら writer-not-deployed として skip する", async () => {
    ctx = createTestDeps();
    Object.assign(ctx.deps, {
      readPassthroughPatchStatusFile: (): never => {
        throw Object.assign(new Error("status file not found"), { code: "ENOENT" });
      },
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(true);
    expect(check).toMatchObject({ ok: true, skipped: true, reason: "writer-not-deployed" });
    expect(check?.detail).toContain("readiness の証明ではありません");
    expect(ctx.exitCodes).toEqual([]);
  });

  it("passthrough patch status の読み取りが EACCES なら errno を表示して NG にする", async () => {
    ctx = createTestDeps();
    Object.assign(ctx.deps, {
      readPassthroughPatchStatusFile: (): never => {
        throw Object.assign(new Error("permission denied\nINJECTED"), { code: "EACCES" });
      },
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("読み込みに失敗しました: EACCES: permission denied INJECTED");
    expect(check?.detail).not.toContain("\n");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("bridge が LISTEN していなければ bridge-not-running として skip する", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus());
    ctx.deps.bridgeListenerProbe = async () => ({ status: "not-listening" });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(true);
    expect(check).toMatchObject({ ok: true, skipped: true, reason: "bridge-not-running" });
    expect(ctx.exitCodes).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")(
    "macOS の最小 PATH でも既定 probe が /usr/sbin/lsof で LISTEN PID を取得する",
    async () => {
      ctx = createTestDeps();
      const bridge = new MockBridgeServer({ token: "unused" });
      const previousPath = process.env.PATH;
      await bridge.start();
      try {
        process.env.PATH = "/usr/bin:/bin";
        delete ctx.deps.bridgeListenerProbe;
        ctx.deps.env.bridges.codex.url = bridge.url;
        ctx.deps.env.bridges.claude.url = bridge.url;
        writePassthroughPatchStatus(
          ctx.deps.hermesHome,
          validPassthroughPatchStatus({ bridgePid: process.pid }),
        );

        await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

        const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
        const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
        expect(result.ok).toBe(true);
        expect(check).toMatchObject({ ok: true });
        expect(ctx.exitCodes).toEqual([]);
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        await bridge.close();
      }
    },
  );

  it("bridge は LISTEN しているが PID を決定できなければ NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus());
    ctx.deps.bridgeListenerProbe = async () => ({ status: "listening", pid: null });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("PID を決定できません");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("bridge LISTEN 状態を判定できなければ NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus());
    ctx.deps.bridgeListenerProbe = async () => ({ status: "unknown", detail: "lsof unavailable" });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("LISTEN PID の判定に失敗しました");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の bridgePid が LISTEN PID と不一致なら NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({ bridgePid: 9_999 }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("bridgePid=9999 が LISTEN PID と一致しません");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の bridgePid が null なら NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({ bridgePid: null }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("bridgePid=null が LISTEN PID と一致しません");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status を読み取れなければ NG にする", async () => {
    ctx = createTestDeps();
    mkdirSync(passthroughPatchStatusPath(ctx.deps.hermesHome), { recursive: true });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("読み込みに失敗しました");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の JSON が不正なら NG にする", async () => {
    ctx = createTestDeps();
    const path = passthroughPatchStatusPath(ctx.deps.hermesHome);
    mkdirSync(join(ctx.deps.hermesHome, "even-shared"), { recursive: true });
    writeFileSync(path, "{broken", { encoding: "utf8", mode: 0o600 });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("JSON 解析に失敗しました");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の root が object でなければ NG にする", async () => {
    ctx = createTestDeps();
    const path = passthroughPatchStatusPath(ctx.deps.hermesHome);
    mkdirSync(join(ctx.deps.hermesHome, "even-shared"), { recursive: true });
    writeFileSync(path, JSON.stringify([]), { encoding: "utf8", mode: 0o600 });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("必須キーが不正です: root");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の schema が文字列でなければ NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({ schema: 1 }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("必須キーが不正です: schema");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の schema が未知なら NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      schema: "passthrough-patch-status/v2",
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("未知のschemaです");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の必須キーが欠けていれば NG にする", async () => {
    ctx = createTestDeps();
    const status = validPassthroughPatchStatus();
    delete status["patchVersion"];
    writePassthroughPatchStatus(ctx.deps.hermesHome, status);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("必須キーが不正です: patchVersion");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の updatedAt に timezone がなければ NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      updatedAt: "2026-08-23T12:34:56",
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check?.detail).toContain("必須キーが不正です: updatedAt");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("passthrough patch status の文字列が1000文字を超えれば NG にする", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      evenTerminalVersion: "v".repeat(1_001),
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "passthrough patch status");
    expect(result.ok).toBe(false);
    expect(check?.detail).toContain("必須キーが不正です: evenTerminalVersion");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("evenTerminalVersion の改行で偽の検査行を注入できない", async () => {
    ctx = createTestDeps();
    writePassthroughPatchStatus(ctx.deps.hermesHome, validPassthroughPatchStatus({
      evenTerminalVersion: "0.8.1\n[OK] INJECTED-FAKE-CHECK: all good",
    }));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline"], { from: "user" });

    const lines = ctx.stdout.text().split(/\r?\n/);
    expect(lines).not.toContain("[OK] INJECTED-FAKE-CHECK: all good");
    expect(lines.find((line) => line.includes("passthrough patch status"))).toContain(
      "evenTerminalVersion=0.8.1 [OK] INJECTED-FAKE-CHECK: all good",
    );
    expect(ctx.exitCodes).toEqual([]);
  });

  it("hermes home は環境変数または OS home から doctor の外で解決する", () => {
    ctx = createTestDeps();
    expect(resolveHermesHome({ HERMES_HOME: "/custom/hermes" }, "/Users/tester")).toBe("/custom/hermes");
    expect(resolveHermesHome({}, "/Users/tester")).toBe("/Users/tester/.hermes-hachi-dev");
  });

  it("--offline でも使用中 bridge のunsafe token fileをfail-closedで報告し値は表示しない", async () => {
    ctx = createTestDeps();
    const secret = "doctor-bridge-secret-value";
    const tokenFile = ctx.deps.env.bridges.codex.tokenFile;
    writeFileSync(tokenFile, secret, { mode: 0o600 });
    chmodSync(tokenFile, 0o644);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const raw = ctx.stdout.text();
    const result = JSON.parse(raw) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "codex bridge");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("token file");
    expect(raw).not.toContain(secret);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("direct-only profiles は未使用 bridge を構造化 skip し、direct runtime 診断だけを実行する", async () => {
    ctx = createTestDeps();
    for (const profile of Object.values(ctx.deps.config.profiles)) {
      profile.transport = "direct";
    }
    writeFileSync(join(ctx.deps.env.home, "config.json"), JSON.stringify(ctx.deps.config), "utf8");
    writeHeartbeat(ctx.deps.env.home, Math.floor(Date.now() / 1000));
    stubHealthyFetch();

    const bridgeProbe = vi.fn(ctx.deps.bridgeIdentityProbe!);
    const bridgeListenerProbe = vi.fn(ctx.deps.bridgeListenerProbe!);
    const modelTransportProbe = vi.fn(ctx.deps.modelTransportProbe!);
    ctx.deps.bridgeIdentityProbe = bridgeProbe;
    ctx.deps.bridgeListenerProbe = bridgeListenerProbe;
    ctx.deps.modelTransportProbe = modelTransportProbe;

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    expect(result.ok).toBe(true);
    for (const provider of ["codex", "claude"]) {
      const bridge = result.checks.find((check) => check.name === `${provider} bridge`);
      expect(bridge).toMatchObject({
        ok: true,
        skipped: true,
        reason: "unused-transport",
      });
      expect(bridge?.detail).toContain("config profiles");
    }
    expect(bridgeProbe).not.toHaveBeenCalled();
    expect(bridgeListenerProbe).not.toHaveBeenCalled();
    expect(result.checks.some((check) => check.name === "passthrough patch status")).toBe(false);
    expect(modelTransportProbe).toHaveBeenCalledTimes(4);
    expect(modelTransportProbe.mock.calls.every((call) => call[1] === "direct")).toBe(true);
    const modelChecks = result.checks.filter((check) => check.name.startsWith("model transport"));
    expect(modelChecks).toHaveLength(4);
    expect(modelChecks.every((check) => check.ok && !check.skipped)).toBe(true);
    expect(modelChecks.every((check) => check.detail.includes("runtime="))).toBe(true);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("mixed profiles は使用中 provider の bridge だけを probe する", async () => {
    ctx = createTestDeps();
    for (const profile of Object.values(ctx.deps.config.profiles)) {
      profile.transport = "direct";
    }
    ctx.deps.config.profiles.plan!.transport = "bridge";
    writeFileSync(join(ctx.deps.env.home, "config.json"), JSON.stringify(ctx.deps.config), "utf8");
    writeHeartbeat(ctx.deps.env.home, Math.floor(Date.now() / 1000));
    stubHealthyFetch();

    const bridgeProbe = vi.fn(ctx.deps.bridgeIdentityProbe!);
    ctx.deps.bridgeIdentityProbe = bridgeProbe;

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const codexBridge = result.checks.find((check) => check.name === "codex bridge");
    const claudeBridge = result.checks.find((check) => check.name === "claude bridge");
    expect(result.ok).toBe(true);
    expect(codexBridge).toMatchObject({ ok: true, skipped: true, reason: "unused-transport" });
    expect(claudeBridge).toMatchObject({ ok: true });
    expect(claudeBridge?.skipped).toBeUndefined();
    expect(bridgeProbe).toHaveBeenCalledTimes(1);
    expect(bridgeProbe).toHaveBeenCalledWith(ctx.deps.env.bridges.claude);
    expect(ctx.exitCodes).toEqual([]);
  });

  it("配送先のないorchestrator requestをNGとして可視化する", async () => {
    ctx = createTestDeps();
    const task = ctx.deps.store.createTask(
      { title: "未回収質問", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.block(task.id, "worker-question: 方針を確認してください", "supervisor");
    ctx.deps.store.createOrGetOrchestratorRequest({
      taskId: task.id,
      questionId: "q_doctor_unavailable",
      question: "方針を確認してください",
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const routing = result.checks.find((check) => check.name === "orchestrator routing");
    expect(result.ok).toBe(false);
    expect(routing).toMatchObject({ ok: false });
    expect(routing?.detail).toContain("unavailableRequests=1");
    expect(routing?.detail).toContain(`unavailableSample=`);
    expect(routing?.detail).toContain(task.id);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("orchestrator sessionはcore共通TTLを超えた場合だけstale表示する", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-12T00:00:00Z") });
    ctx = createTestDeps();
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "doctor-ttl",
      project: "dev",
      repoCommonDir: process.cwd(),
    });
    const session = ctx.deps.store.startOrchestratorSession({
      orchestratorId: orchestrator.id,
      provider: "claude",
      providerSessionId: "claude-doctor-ttl",
    });
    const mission = ctx.deps.store.createTask(
      { title: "doctor ttl mission", body: `cwd: ${process.cwd()}`, tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.bindTaskToOrchestrator(mission.id, orchestrator.id, "primary");
    ctx.deps.store.addOrchestratorWatch({
      orchestratorId: orchestrator.id,
      scope: "subtree",
      selector: mission.id,
      role: "primary",
    });
    ctx.deps.tmuxProbe = { available: () => true, listSessionNames: () => [] };
    ctx.deps.claudeTrustProbe = { isTrusted: () => true };
    const now = Math.floor(Date.now() / 1000);
    ctx.deps.store.heartbeatOrchestratorSession(
      session.id,
      session.generation,
      now - ORCHESTRATOR_SESSION_STALE_SECONDS,
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const boundaryResult = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const boundaryRouting = boundaryResult.checks.find((check) => check.name === "orchestrator routing");
    expect(boundaryRouting?.detail).toContain("staleSessions=0");
    expect(ctx.exitCodes).toEqual([]);

    ctx.stdout.clear();
    ctx.deps.store.heartbeatOrchestratorSession(
      session.id,
      session.generation,
      now - ORCHESTRATOR_SESSION_STALE_SECONDS - 1,
    );
    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const staleResult = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const staleRouting = staleResult.checks.find((check) => check.name === "orchestrator routing");
    expect(staleResult.ok).toBe(false);
    expect(staleRouting?.detail).toContain("staleSessions=1");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("worker process hygiene は bridge 子孫総数が200件超なら warn 扱いで NG 表示する", async () => {
    ctx = createTestDeps();
    ctx.deps.processListProvider = async () => [
      { pid: 10, ppid: 1, pgid: 10, etime: "01:00", startTime: "start-10", command: "kanban-shared-app-server" },
      { pid: 20, ppid: 10, pgid: 20, etime: "01:00", startTime: "start-20", command: "codex" },
      ...Array.from({ length: 201 }, (_, index) => ({
        pid: 1000 + index,
        ppid: 20,
        pgid: 1000 + index,
        etime: "01:00",
        startTime: `start-${1000 + index}`,
        command: "mcp-server",
      })),
    ];

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "worker process hygiene");
    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("bridgeDescendants=201");
    expect(check?.detail).toContain("warn");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("worker process hygiene は direct 残留 group 数を表示する", async () => {
    ctx = createTestDeps();
    const stateDir = join(ctx.deps.env.home, "state", "direct-sessions");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "direct-old.json"), JSON.stringify({ pid: 4567, exitFile: join(stateDir, "direct-old.exit") }), "utf8");
    writeFileSync(join(stateDir, "direct-old.exit"), "0", "utf8");
    ctx.deps.processListProvider = async () => [
      { pid: 9876, ppid: 1, pgid: 4567, etime: "10:00", startTime: "start-9876", command: "sh" },
    ];

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "worker process hygiene");
    expect(result.ok).toBe(true);
    expect(check?.detail).toContain("directResidualGroups=1");
  });

  it("config.json が無い場合は既定値使用として ok になる", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const configCheck = result.checks.find((c) => c.name === "config.json");
    expect(configCheck?.ok).toBe(true);
    expect(configCheck?.detail).toContain("既定値");
  });

  it("runtime profile requirementとcurrent host adapter設定のdriftをread-onlyでNG表示する", async () => {
    ctx = createTestDeps();
    const repo = join(ctx.deps.env.home, "profile-repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
    const repoCommonDir = realpathSync.native(join(repo, ".git"));
    const original = runtimeResourcesSchema.parse({
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      dockerContext: "doctor-context",
      worktreePostgres: {
        image: "postgres:16",
        containerPort: 5432,
        healthCheck: { command: ["pg_isready"], intervalMs: 1000, timeoutMs: 1000, retries: 3 },
      },
      projects: [{
        project: "doctor-project",
        repoCommonDir,
        profiles: [{
          id: "postgres-v1",
          bundleKind: "worktree_postgres",
          hostAdapter: "worktreePostgres",
        }],
      }],
    });
    const task = ctx.deps.store.createTask(
      { title: "profile drift", body: `cwd: ${repo}`, tenant: "dev", status: "ready" },
      "tester",
    );
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "doctor-profile-owner",
      project: "doctor-project",
      repoCommonDir,
    });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const resourceStore = ctx.deps.store as unknown as {
      createOrGetRuntimeResourceRequirement(input: {
        taskId: string;
        name: string;
        bundleKind: "worktree_postgres";
        spec: Record<string, unknown>;
        idempotencyKey: string;
      }): unknown;
    };
    resourceStore.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "runtime-profile:postgres-v1",
      bundleKind: "worktree_postgres",
      spec: {
        version: 1,
        requiredMembers: ["docker_container", "tcp_port", "postgres_endpoint"],
        ownershipSnapshot: {
          version: 1,
          profileId: "postgres-v1",
          orchestratorId: orchestrator.id,
          project: "doctor-project",
          repoCommonDir,
          canonicalWorktree: realpathSync.native(repo),
        },
        hostAdapterSnapshot: createRuntimeProjectHostAdapterSnapshot(original, "worktreePostgres"),
      },
      idempotencyKey: `${task.id}:runtime-profile:postgres-v1`,
    });
    const changed = {
      ...original,
      worktreePostgres: { ...original.worktreePostgres!, image: "postgres:17" },
    };
    writeFileSync(
      join(ctx.deps.env.home, "config.json"),
      JSON.stringify({ ...ctx.deps.config, runtimeResources: changed }),
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "runtime resource profiles");
    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("drift:");
  });

  it("bound leaseのmanifest fenceが1世代遅れていればread-onlyでNG表示する", async () => {
    ctx = createTestDeps();
    const now = Math.floor(Date.now() / 1000);
    const runtimeResources = runtimeResourcesSchema.parse({
      mode: "enforce",
      provisioningEnabled: true,
      leaseTtlSeconds: 300,
      dockerContext: "doctor-bound-context",
      worktreePostgres: {
        image: "postgres:16",
        containerPort: 5432,
        healthCheck: { command: ["pg_isready"], intervalMs: 1000, timeoutMs: 1000, retries: 3 },
      },
      projects: [],
    });
    writeFileSync(
      join(ctx.deps.env.home, "config.json"),
      JSON.stringify({ ...ctx.deps.config, runtimeResources }),
      "utf8",
    );
    const task = ctx.deps.store.createTask(
      { title: "bound manifest fence", body: `cwd: ${ctx.deps.env.home}`, tenant: "dev", status: "ready" },
      "tester",
    );
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "doctor-bound-owner",
      project: "doctor-project",
      repoCommonDir: ctx.deps.env.home,
    });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const resourceStore = ctx.deps.store as unknown as {
      createOrGetRuntimeResourceRequirement(input: Record<string, unknown>): { id: string };
      reserveRuntimeResourceLease(input: Record<string, unknown>): { id: string; fence: number };
      claimRuntimeResourceLease(id: string, fence: number, actor: string): { id: string; fence: number };
      addRuntimeResourceMember(input: Record<string, unknown>): void;
      transitionRuntimeResourceLease(input: Record<string, unknown>): { id: string; fence: number };
      startRun(taskId: string, provider: "codex", sessionId: string, meta: Record<string, unknown>): { id: number };
      bindRuntimeResourceLeaseRun(input: Record<string, unknown>): { id: string; fence: number };
    };
    const requirement = resourceStore.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "postgres",
      bundleKind: "worktree_postgres",
      spec: { version: 1, requiredMembers: ["postgres_endpoint"] },
      idempotencyKey: `${task.id}:postgres`,
    });
    const reserved = resourceStore.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: "dev",
      project: "doctor-project",
      repoCommonDir: ctx.deps.env.home,
      worktree: ctx.deps.env.home,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: now + 300,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "tester",
    });
    const provisioning = resourceStore.claimRuntimeResourceLease(reserved.id, reserved.fence, "tester");
    resourceStore.addRuntimeResourceMember({
      leaseId: reserved.id,
      expectedLeaseFence: provisioning.fence,
      kind: "postgres_endpoint",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: "doctor-bound-context",
      hostIp: "127.0.0.1",
      hostPort: 49152,
      containerPort: 5432,
      labelsHash: runtimeLabelsHash({}),
      provenance: { version: 1, labels: {} },
      observedAt: now,
      actor: "tester",
    });
    const active = resourceStore.transitionRuntimeResourceLease({
      leaseId: reserved.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "tester",
    });
    const run = resourceStore.startRun(task.id, "codex", "doctor-bound-session", {
      serverUrl: "direct",
    });
    const bound = resourceStore.bindRuntimeResourceLeaseRun({
      leaseId: active.id,
      expectedFence: active.fence,
      runId: run.id,
      actor: "tester",
    });
    expect(bound.fence).toBe(active.fence + 1);
    const secretRoot = join(ctx.deps.env.home, "runtime-secrets", active.id);
    const manifestRoot = join(ctx.deps.env.home, "runtime-manifests");
    mkdirSync(secretRoot, { recursive: true, mode: 0o700 });
    mkdirSync(manifestRoot, { recursive: true, mode: 0o700 });
    const secretFilePath = join(secretRoot, "postgres-password");
    writeFileSync(secretFilePath, "doctor-test-password\n", { mode: 0o600 });
    writeFileSync(join(manifestRoot, `${active.id}.json`), JSON.stringify({
      version: 1,
      leaseId: active.id,
      fence: active.fence,
      bundleKind: "worktree_postgres",
      host: "127.0.0.1",
      port: 49152,
      database: "hachi_doctor",
      role: "hachi_doctor",
      secretFilePath,
    }), { mode: 0o600 });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "runtime resource leases");
    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain(`manifest:${active.id}`);
  });

  it("quarantined lease/cleanup requestをread-onlyで不整合として表示する", async () => {
    ctx = createTestDeps();
    const resourceStore = ctx.deps.store as unknown as {
      createOrGetRuntimeResourceRequirement(input: {
        taskId: string;
        name: string;
        bundleKind: "worktree_preview";
        spec: Record<string, unknown>;
        idempotencyKey: string;
      }): { id: string };
      reserveRuntimeResourceLease(input: Record<string, unknown>): { id: string; fence: number };
      claimRuntimeResourceLease(id: string, fence: number, actor: string): { id: string; fence: number };
      addRuntimeResourceMember(input: Record<string, unknown>): void;
      transitionRuntimeResourceLease(input: Record<string, unknown>): { id: string; fence: number };
      transitionRuntimeResourceLeaseWithCleanupRequest(input: Record<string, unknown>): {
        request: { id: string };
      };
      quarantineRuntimeCleanupRequest(input: Record<string, unknown>): void;
    };
    const task = ctx.deps.store.createTask(
      { title: "cleanup quarantine", body: `cwd: ${ctx.deps.env.home}`, tenant: "dev", status: "ready" },
      "tester",
    );
    const orchestrator = ctx.deps.store.registerOrchestrator({
      label: "doctor-cleanup-owner",
      project: "doctor-project",
      repoCommonDir: ctx.deps.env.home,
    });
    ctx.deps.store.bindTaskToOrchestrator(task.id, orchestrator.id, "primary");
    const requirement = resourceStore.createOrGetRuntimeResourceRequirement({
      taskId: task.id,
      name: "preview",
      bundleKind: "worktree_preview",
      spec: { version: 1, requiredMembers: ["tcp_port"] },
      idempotencyKey: `${task.id}:preview`,
    });
    const reserved = resourceStore.reserveRuntimeResourceLease({
      requirementId: requirement.id,
      controllerOrchestratorId: orchestrator.id,
      board: "dev",
      project: "doctor-project",
      repoCommonDir: ctx.deps.env.home,
      worktree: ctx.deps.env.home,
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      provenanceVersion: 1,
      rolloutGeneration: 1,
      actor: "tester",
    });
    const provisioning = resourceStore.claimRuntimeResourceLease(reserved.id, reserved.fence, "tester");
    resourceStore.addRuntimeResourceMember({
      leaseId: provisioning.id,
      expectedLeaseFence: provisioning.fence,
      kind: "tcp_port",
      state: "active",
      cleanupPolicy: "auto",
      managed: true,
      ephemeral: true,
      scopeKey: "doctor-context",
      hostIp: "127.0.0.1",
      hostPort: 49152,
      containerPort: 3000,
      labelsHash: runtimeLabelsHash({}),
      provenance: { version: 1, labels: {} },
      observedAt: Math.floor(Date.now() / 1000),
      actor: "tester",
    });
    const active = resourceStore.transitionRuntimeResourceLease({
      leaseId: provisioning.id,
      expectedFence: provisioning.fence,
      from: "provisioning",
      to: "active",
      actor: "tester",
    });
    ctx.deps.store.block(task.id, "needs-manual: cleanup quarantine fixture", "tester");
    ctx.deps.store.transition({ taskId: task.id, to: "done", actor: "tester" });
    const cleanup = resourceStore.transitionRuntimeResourceLeaseWithCleanupRequest({
      leaseId: active.id,
      expectedFence: active.fence,
      from: "active",
      terminalReason: "owner_terminal",
      decisionClass: "auto",
      reason: "doctor quarantine fixture",
      actor: "tester",
    });
    resourceStore.quarantineRuntimeCleanupRequest({
      requestId: cleanup.request.id,
      reason: "doctor fixture mismatch",
      actor: "tester",
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const leaseCheck = result.checks.find((candidate) => candidate.name === "runtime resource leases");
    const cleanupCheck = result.checks.find((candidate) => candidate.name === "runtime resource cleanup");
    expect(result.ok).toBe(false);
    expect(leaseCheck?.detail).toContain("quarantined");
    expect(cleanupCheck?.detail).toContain("quarantined");
  });

  it("steward state が新鮮なら直近実行サマリを OK 表示する", async () => {
    ctx = createTestDeps();
    writeStewardState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 10,
      lastProposalCount: 3,
      lastAppliedCount: 1,
      lastProposedCount: 2,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      claimGeneration: 7,
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state");
    expect(result.ok).toBe(true);
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("proposals=3");
    expect(check?.detail).toContain("applied=1");
    expect(check?.detail).toContain("claimGeneration=7");
  });

  it("steward state に lastArchivedByEvidence があれば detail に not-observable:* の evidence 別件数だけを追記する（clean-head-reachable は統合を観測済みのため除外する）", async () => {
    ctx = createTestDeps();
    writeStewardState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 10,
      lastProposalCount: 3,
      lastAppliedCount: 1,
      lastProposedCount: 2,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      lastArchivedByEvidence: { "not-observable:repo-root": 2, "clean-head-reachable": 1 },
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state");
    expect(result.ok).toBe(true);
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("proposals=3");
    expect(check?.detail).toContain("archivedByEvidence={not-observable:repo-root:2}");
    // clean-head-reachable は merge-base --is-ancestor で統合先への到達を証明した上での archive であり、
    // 「統合を観測せずに」archive した件数の集計対象ではないため detail に含めてはいけない
    expect(check?.detail).not.toContain("clean-head-reachable");
  });

  it("steward state に lastArchivedByEvidence が not-observable:* を含まなければ detail に archivedByEvidence を追記しない（clean-head-reachable / clean-patch-equivalent のみのケース）", async () => {
    ctx = createTestDeps();
    writeStewardState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 10,
      lastProposalCount: 3,
      lastAppliedCount: 1,
      lastProposedCount: 2,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      lastArchivedByEvidence: { "clean-head-reachable": 1, "clean-patch-equivalent": 2 },
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state");
    expect(result.ok).toBe(true);
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain("archivedByEvidence");
  });

  it("steward state に lastArchivedByEvidence が無ければ detail に archivedByEvidence を追記しない（後方互換）", async () => {
    ctx = createTestDeps();
    writeStewardState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 10,
      lastProposalCount: 3,
      lastAppliedCount: 1,
      lastProposedCount: 2,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state");
    expect(result.ok).toBe(true);
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain("archivedByEvidence");
  });

  it("steward state は既定 cadence 30分内なら stale 扱いしない", async () => {
    ctx = createTestDeps();
    writeStewardState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 20 * 60,
      lastProposalCount: 0,
      lastAppliedCount: 0,
      lastProposedCount: 0,
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state");
    expect(result.ok).toBe(true);
    expect(check?.ok).toBe(true);
    expect(check?.detail).not.toContain("鮮度閾値");
  });

  it("steward state が autoDisabled なら NG 表示する", async () => {
    ctx = createTestDeps();
    writeStewardState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 10,
      consecutiveFailures: 3,
      autoDisabled: true,
      autoDisabledReason: "連続3回失敗: 出力パース不能",
      claimGeneration: 8,
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state");
    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("自動無効化");
    expect(check?.detail).toContain("claimGeneration=8");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("brief state が autoDisabled ならdoctorでNG表示する", async () => {
    ctx = createTestDeps();
    Object.assign(ctx.deps.config, { brief: { times: ["07:30", "19:30"] } });
    writeBriefState(ctx.deps.env.home, {
      lastRunAt: Math.floor(Date.now() / 1000) - 10,
      lastError: "brief direct session timeout",
      consecutiveFailures: 3,
      autoDisabled: true,
      autoDisabledReason: "連続3回失敗: brief direct session timeout",
      claimGeneration: 12,
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "brief state");
    expect(result.ok).toBe(false);
    expect(check).toMatchObject({ ok: false });
    expect(check?.detail).toContain("自動無効化");
    expect(check?.detail).toContain("claimGeneration=12");
  });

  it("brief state が直近予定を完了していればOK表示する", async () => {
    vi.useFakeTimers({ now: new Date(2026, 7, 18, 20, 0, 0) });
    ctx = createTestDeps();
    Object.assign(ctx.deps.config, { brief: { times: ["07:30", "19:30"] } });
    writeBriefState(ctx.deps.env.home, {
      lastRunAt: Math.floor(new Date(2026, 7, 18, 19, 45, 0).getTime() / 1000),
      lastError: "",
      consecutiveFailures: 0,
      autoDisabled: false,
      autoDisabledReason: "",
      claimGeneration: 13,
    });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((candidate) => candidate.name === "brief state");
    expect(check).toMatchObject({ ok: true });
    expect(check?.detail).toContain("claimGeneration=13");
  });

  it("steward state lock guardのmalformed残骸をNG表示し、自動削除しない", async () => {
    ctx = createTestDeps();
    const guardPath = join(ctx.deps.env.home, STEWARD_STATE_LOCK_GUARD_NAME);
    writeFileSync(guardPath, "{}", { mode: 0o600 });
    chmodSync(guardPath, 0o600);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state lock");
    expect(result.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("guard lock不正");
    expect(readFileSync(guardPath, "utf8")).toBe("{}");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("live steward main lockは診断できるがnonceを表示しない", async () => {
    ctx = createTestDeps();
    const lock = acquireStewardStateLock(ctx.deps.env.home, "supervisor-steward");
    expect(lock).not.toBeNull();

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "steward state lock");
    expect(result.ok).toBe(true);
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("main lock使用中");
    expect(JSON.stringify(result)).not.toContain(lock!.operationId);
    lock!.release();
  });

  it("web-token はパス・存在有無・mode のみを表示し、値は表示しない", async () => {
    ctx = createTestDeps();
    const tokenPath = join(ctx.deps.env.home, "web-token");
    const secretToken = "secret-web-token-value";
    writeFileSync(tokenPath, secretToken, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const tokenCheck = result.checks.find((c) => c.name === "web-token");
    expect(result.ok).toBe(true);
    expect(tokenCheck?.ok).toBe(true);
    expect(tokenCheck?.detail).toContain(`path=${tokenPath}`);
    expect(tokenCheck?.detail).toContain("exists=true");
    expect(tokenCheck?.detail).toContain("mode=0600");
    expect(JSON.stringify(result)).not.toContain(secretToken);
  });

  it("telegram-token はパス・存在有無・mode のみを表示し、値は表示しない", async () => {
    ctx = createTestDeps();
    const tokenPath = join(ctx.deps.env.home, "telegram-token");
    const secretToken = "123456:secret-telegram-token";
    writeFileSync(tokenPath, secretToken, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const tokenCheck = result.checks.find((c) => c.name === "telegram-token");
    expect(result.ok).toBe(true);
    expect(tokenCheck?.ok).toBe(true);
    expect(tokenCheck?.detail).toContain(`path=${tokenPath}`);
    expect(tokenCheck?.detail).toContain("exists=true");
    expect(tokenCheck?.detail).toContain("mode=0600");
    expect(JSON.stringify(result)).not.toContain(secretToken);
  });

  it("telegram-token の mode が 0600 以外なら NG になるが、値は表示しない", async () => {
    ctx = createTestDeps();
    const tokenPath = join(ctx.deps.env.home, "telegram-token");
    const secretToken = "123456:secret-telegram-token";
    writeFileSync(tokenPath, secretToken, { mode: 0o644 });
    chmodSync(tokenPath, 0o644);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const tokenCheck = result.checks.find((c) => c.name === "telegram-token");
    expect(result.ok).toBe(false);
    expect(tokenCheck?.ok).toBe(false);
    expect(tokenCheck?.detail).toContain("exists=true");
    expect(tokenCheck?.detail).toContain("mode=0644");
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("web-token の mode が 0600 以外なら NG になるが、値は表示しない", async () => {
    ctx = createTestDeps();
    const tokenPath = join(ctx.deps.env.home, "web-token");
    const secretToken = "secret-web-token-value";
    writeFileSync(tokenPath, secretToken, { mode: 0o644 });
    chmodSync(tokenPath, 0o644);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const tokenCheck = result.checks.find((c) => c.name === "web-token");
    expect(result.ok).toBe(false);
    expect(tokenCheck?.ok).toBe(false);
    expect(tokenCheck?.detail).toContain("exists=true");
    expect(tokenCheck?.detail).toContain("mode=0644");
    expect(JSON.stringify(result)).not.toContain(secretToken);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("bridge identity が 404 を返すとポート乗っ取り疑いとして doctor 全体が exit 1 になる", async () => {
    ctx = createTestDeps();
    ctx.deps.bridgeIdentityProbe = async (bridge) => {
      if (bridge === ctx.deps.env.bridges.codex) {
        return {
          ok: false,
          failure: { kind: "http", detail: "status=404", status: 404, suspectPortHijack: true },
        };
      }
      return { ok: true, sessionCount: 0 };
    };
    stubHealthyFetch();

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    expect(result.ok).toBe(false);
    const codexCheck = result.checks.find((c) => c.name === "codex bridge");
    expect(codexCheck?.ok).toBe(false);
    expect(codexCheck?.detail).toContain("ポート乗っ取りの疑い");
    expect(codexCheck?.detail).toContain("status=404");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("bridge identity が非 JSON 応答を返すとポート乗っ取り疑いとして NG になる", async () => {
    ctx = createTestDeps();
    ctx.deps.bridgeIdentityProbe = async (bridge) => {
      if (bridge === ctx.deps.env.bridges.claude) {
        return {
          ok: false,
          failure: { kind: "invalid-json", detail: "JSON parse failed", suspectPortHijack: true },
        };
      }
      return { ok: true, sessionCount: 0 };
    };
    stubHealthyFetch();

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const claudeCheck = result.checks.find((c) => c.name === "claude bridge");
    expect(result.ok).toBe(false);
    expect(claudeCheck?.ok).toBe(false);
    expect(claudeCheck?.detail).toContain("ポート乗っ取りの疑い");
    expect(claudeCheck?.detail).toContain("invalid-json");
  });

  it("config.json が意味的に不正な場合（defaultProfile 不整合等）は原因を報告して exit 1 になる（docs/contract.md §12.6-5, fail-closed）", async () => {
    ctx = createTestDeps();
    writeFileSync(
      join(ctx.deps.env.home, "config.json"),
      JSON.stringify({
        profiles: { solo: { provider: "codex", model: "gpt-5.4" } },
        allowlist: { codex: ["gpt-5.4"], claude: [] },
        resourceGuard: { maxInFlight: 1, maxLaunchesPerTick: 1 },
        defaultProfile: "does-not-exist",
      }),
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    expect(result.ok).toBe(false);
    const configCheck = result.checks.find((c) => c.name === "config.json");
    expect(configCheck?.ok).toBe(false);
    expect(configCheck?.detail).toContain("defaultProfile が profiles に存在しません");
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("テキスト出力は [OK]/[NG] 形式の行を含む", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline"], { from: "user" });

    const text = ctx.stdout.text();
    expect(text).toContain("[OK] HACHI_KANBAN_HOME");
    expect(text).toContain("[OK] DB");
  });

  it("非終端タスクの verify 予約語を task ID と予約語だけで報告する", async () => {
    ctx = createTestDeps();
    const activeTask = ctx.deps.store.createTask(
      { title: "active title", body: "cwd: /tmp", tenant: "dev", status: "todo" },
      "tester",
    );
    const terminalTask = ctx.deps.store.createTask(
      { title: "terminal title", body: "cwd: /tmp", tenant: "dev", status: "ready" },
      "tester",
    );
    ctx.deps.store.block(terminalTask.id, "codex-in-progress: test fixture", "supervisor");
    ctx.deps.store.transition({ taskId: terminalTask.id, to: "done", actor: "tester" });

    const raw = new Database(ctx.deps.env.dbPath);
    try {
      raw.prepare(`UPDATE tasks SET body = ? WHERE id = ?`).run(
        "cwd: /tmp\nverify: TeSt\nDOCTOR_SECRET_BODY",
        activeTask.id,
      );
      raw.prepare(`UPDATE tasks SET body = ? WHERE id = ?`).run(
        "cwd: /tmp\nverify: focused\nTERMINAL_SECRET_BODY",
        terminalTask.id,
      );
    } finally {
      raw.close();
    }

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const output = ctx.stdout.text();
    const result = JSON.parse(output) as { checks: DoctorCheckResult[]; ok: boolean };
    const verifyCheck = result.checks.find((check) => check.name === "verify directives");
    expect(verifyCheck).toEqual({
      name: "verify directives",
      ok: false,
      detail: `taskId=${activeTask.id} reservedWord=test`,
    });
    expect(result.ok).toBe(false);
    expect(output).not.toContain("DOCTOR_SECRET_BODY");
    expect(output).not.toContain("TERMINAL_SECRET_BODY");
    expect(output).not.toContain(terminalTask.id);
    expect(ctx.exitCodes).toEqual([1]);
  });

  it("supervisor heartbeat ファイルが存在しない場合は NG になる（docs/contract.md §33.3）", async () => {
    ctx = createTestDeps();
    stubHealthyFetch();

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "supervisor heartbeat");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("存在しません");
    expect(result.ok).toBe(false);
  });

  it("supervisor heartbeat の鮮度が300秒以内なら OK になる", async () => {
    ctx = createTestDeps();
    stubHealthyFetch();
    const nowSec = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    writeHeartbeat(ctx.deps.env.home, nowSec - 10);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "supervisor heartbeat");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("10秒前");
  });

  it("runtime capability probe失敗はunknownをsupportedにせず警告表示する", async () => {
    ctx = createTestDeps();
    stubHealthyFetch();
    writeHeartbeat(ctx.deps.env.home, Math.floor(Date.now() / 1000));
    ctx.deps.modelTransportProbe = async () => ({ ok: false, detail: "probe timeout" });

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const checks = result.checks.filter((check) => check.name.startsWith("model transport"));
    expect(checks).toHaveLength(4);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(checks.every((check) => check.detail.includes("警告: unknown"))).toBe(true);
    expect(checks.every((check) => !check.detail.includes("supported"))).toBe(true);
  });

  it("supervisor heartbeat の鮮度が300秒を超えると NG になる", async () => {
    ctx = createTestDeps();
    stubHealthyFetch();
    const nowSec = 1_800_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    writeHeartbeat(ctx.deps.env.home, nowSec - 301);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "supervisor heartbeat");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("鮮度閾値300秒");
    expect(result.ok).toBe(false);
  });

  it("supervisor heartbeat の JSON パースに失敗する場合は NG になる", async () => {
    ctx = createTestDeps();
    stubHealthyFetch();
    const dir = join(ctx.deps.env.home, "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "supervisor-heartbeat.json"), "not-json{{{", "utf8");

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "supervisor heartbeat");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("JSON 解析に失敗");
  });

  it("supervisor heartbeat の ts が数値でない場合も NG になる", async () => {
    ctx = createTestDeps();
    stubHealthyFetch();
    const dir = join(ctx.deps.env.home, "state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "supervisor-heartbeat.json"),
      JSON.stringify({ ts: "not-a-number", pid: 1, tickCount: 1, intervalSec: 30 }),
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "supervisor heartbeat");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("JSON 解析に失敗");
  });

  it("web healthz が 200 かつ ok:true なら OK になる（docs/contract.md §33.3）", async () => {
    ctx = createTestDeps();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, taskCount: 3 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "web healthz");
    expect(check?.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9131/healthz");
  });

  it("web healthz は HACHI_KANBAN_WEB_PORT を指定するとその port を使う", async () => {
    ctx = createTestDeps();
    process.env.HACHI_KANBAN_WEB_PORT = "9999";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, taskCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9999/healthz");
  });

  it("web healthz は 200 以外の status なら NG になる", async () => {
    ctx = createTestDeps();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false }), { status: 503 })));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const check = result.checks.find((c) => c.name === "web healthz");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("status=503");
    expect(result.ok).toBe(false);
  });

  it("web healthz は body が ok:true でない場合は NG になる", async () => {
    ctx = createTestDeps();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, taskCount: 0 }), { status: 200 })),
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "web healthz");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("ok:true ではありません");
  });

  it("web healthz は応答 body が JSON でない場合は NG になる", async () => {
    ctx = createTestDeps();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "web healthz");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("JSON 解析に失敗");
  });

  it("web healthz は fetch が失敗（ネットワークエラー）した場合は NG になる", async () => {
    ctx = createTestDeps();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await buildProgram(ctx.deps).parseAsync(["doctor", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "web healthz");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("接続に失敗しました");
  });

  it("log rotation は supervisor.jsonl が無ければ OK になる", async () => {
    ctx = createTestDeps();

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "log rotation");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("current=0B");
    expect(check?.detail).toContain("generations=0");
  });

  it("log rotation は config.json の logging 閾値を現行ファイルが超えていれば NG になる", async () => {
    ctx = createTestDeps();
    // config.json 全体は loadConfig 側の検証（checkConfig）にも通るよう有効な形にした上で、
    // hachiConfigSchema が知らない logging セクションを追加する（凍結契約を拡張しない独立読み取り）。
    writeFileSync(
      join(ctx.deps.env.home, "config.json"),
      JSON.stringify({
        profiles: {
          plan: { provider: "claude", model: "claude-opus-4-6" },
          review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
          implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
          docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
        },
        allowlist: {
          codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
          claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
        },
        resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
        defaultProfile: "implement",
        logging: { maxSizeBytes: 10, maxGenerations: 2 },
      }),
      "utf8",
    );
    const logsDir = join(ctx.deps.env.home, "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "supervisor.jsonl"), "x".repeat(50), "utf8");

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const configCheck = result.checks.find((c) => c.name === "config.json");
    expect(configCheck?.ok).toBe(true);
    const check = result.checks.find((c) => c.name === "log rotation");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("現行ファイルが閾値到達(50B >= 10B)");
    expect(result.ok).toBe(false);
  });

  it("R2: log rotation は logging 未設定なら実効値がスキーマ既定値になり、出所は schema-default と表示する", async () => {
    ctx = createTestDeps();
    // config.json 自体を作らない（= logging 未設定）。実効値はスキーマ既定値（50MiB/10世代）になる。

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "log rotation");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("threshold=52428800B/10世代");
    expect(check?.detail).toContain("source=schema-default");
  });

  it("R2: log rotation は logging 設定済みなら実効値が設定値になり、出所は config と表示する", async () => {
    ctx = createTestDeps();
    writeFileSync(
      join(ctx.deps.env.home, "config.json"),
      JSON.stringify({
        profiles: {
          plan: { provider: "claude", model: "claude-opus-4-6" },
          review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
          implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
          docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
        },
        allowlist: {
          codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
          claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
        },
        resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
        defaultProfile: "implement",
        logging: { maxSizeBytes: 999, maxGenerations: 5 },
      }),
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[] };
    const check = result.checks.find((c) => c.name === "log rotation");
    expect(check?.detail).toContain("threshold=999B/5世代");
    expect(check?.detail).toContain("source=config");
  });

  it("log rotation は config.json の logging セクションが不正なら NG になり検証エラーを表示する", async () => {
    ctx = createTestDeps();
    // config.json 全体は loadConfig 側の検証（checkConfig）にも通るよう有効な形にした上で、
    // logging セクションだけを壊す（maxSizeBytes は正の数のみ許容）。
    writeFileSync(
      join(ctx.deps.env.home, "config.json"),
      JSON.stringify({
        profiles: {
          plan: { provider: "claude", model: "claude-opus-4-6" },
          review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
          implement: { provider: "codex", model: "gpt-5.6-terra", effort: "xhigh" },
          docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
        },
        allowlist: {
          codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
          claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
        },
        resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
        defaultProfile: "implement",
        logging: { maxSizeBytes: -1 },
      }),
      "utf8",
    );

    await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

    const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
    const configCheck = result.checks.find((c) => c.name === "config.json");
    expect(configCheck?.ok).toBe(true);
    const check = result.checks.find((c) => c.name === "log rotation");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("config.json の logging セクションが不正です");
    expect(result.ok).toBe(false);
  });

  describe("orchestrator helpers", () => {
    it("既定fixture（createTestDepsが用意するrepo内シム5本）はOKになる（t_eac0371a7a1a368e）", async () => {
      ctx = createTestDeps();

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("hachi-handover-now=ok");
      expect(check?.detail).toContain("hhn=ok");
      expect(check?.detail).toContain("hachi-orch-enable=ok");
      // 5本揃っている場合は警告を付けない（警告文の有無で「全部揃っている」を区別する）
      expect(check?.detail).not.toContain("警告:");
      expect(result.ok).toBe(true);
    });

    it("5本とも未導入ならmissingを警告として報告するがdoctorはfailさせない（マシン再構築で~/.local/binが消えた状態を再現）", async () => {
      ctx = createTestDeps();
      const emptyBinDir = join(ctx.deps.env.home, "empty-bin");
      mkdirSync(emptyBinDir, { recursive: true });
      ctx.deps.orchestratorHelperBinDir = emptyBinDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain("hachi-handover-now=missing");
      expect(check?.detail).toContain("hhn=missing");
      expect(check?.detail).toContain("hachi-orch-enable=missing");
      expect(check?.detail).toContain("cc-cache-ttl=missing");
      expect(check?.detail).toContain("hachi-watch-stop=missing");
      // 一般利用者の環境にはこの5本が無いのが正常なので、doctor 全体は green のまま
      expect(result.ok).toBe(true);
      expect(ctx.exitCodes).toEqual([]);
    });

    it("シム形式ではない実体ファイル（原本）が置かれていれば警告として報告する", async () => {
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "real-body-bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "hachi-orch-enable"), "#!/bin/bash\nset -euo pipefail\necho real-body\n", {
        mode: 0o755,
      });
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain("hachi-orch-enable=not-a-shim");
    });

    it("repo外を指すシムはoutside-repoとして警告に含める", async () => {
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "outside-bin");
      const otherRepo = join(ctx.deps.env.home, "other-checkout", "scripts", "hachi-handover-now");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "hachi-handover-now"), `#!/bin/sh\nexec "${otherRepo}" "$@"\n`, { mode: 0o755 });
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain(`hachi-handover-now=outside-repo:${otherRepo}`);
    });

    it("解決先が repo外かつ末尾が=okの罠パス（/tmp/outside=ok）でもfail-openせず警告を付ける（t_eac0371a7a1a368e rework 2周目）", async () => {
      // 二審指摘の再現条件そのもの: 旧実装は `results.every((r) => r.endsWith("=ok"))` という
      // suffix 判定だったため、outside-repo の detail 文字列がたまたま `=ok` で終わると
      // 異常なのに「全部揃っている」扱いになっていた。他4本は正規のrepo内シムにして
      // 「1本だけ罠」でも警告が消えないことを確認する（5本とも欠落していると別要因で
      // 警告が付き検証にならないため）。検査は警告扱いになったので、fail-open の不在は
      // `ok:false` ではなく「警告文が付いていること」で見る。
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "outside-suffix-ok-trap-bin");
      const repoRoot = ctx.deps.orchestratorHelperRepoRoot as string;
      mkdirSync(binDir, { recursive: true });
      const handoverSource = join(repoRoot, "scripts", "hachi-handover-now");
      writeFileSync(join(binDir, "hachi-handover-now"), `#!/bin/sh\nexec "${handoverSource}" "$@"\n`, {
        mode: 0o755,
      });
      writeFileSync(join(binDir, "hhn"), `#!/bin/sh\nexec "${handoverSource}" "$@"\n`, { mode: 0o755 });
      const cacheTtlSource = join(repoRoot, "scripts", "orchestrator", "cc-cache-ttl");
      writeFileSync(join(binDir, "cc-cache-ttl"), `#!/bin/sh\nexec "${cacheTtlSource}" "$@"\n`, { mode: 0o755 });
      const watchStopSource = join(repoRoot, "scripts", "orchestrator", "hachi-watch-stop");
      writeFileSync(join(binDir, "hachi-watch-stop"), `#!/bin/sh\nexec "${watchStopSource}" "$@"\n`, { mode: 0o755 });
      const trapSource = "/tmp/outside=ok";
      writeFileSync(join(binDir, "hachi-orch-enable"), `#!/bin/sh\nexec "${trapSource}" "$@"\n`, { mode: 0o755 });
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.detail).toContain("hachi-handover-now=ok");
      expect(check?.detail).toContain("hhn=ok");
      expect(check?.detail).toContain("hachi-watch-stop=ok");
      expect(check?.detail).toContain(`hachi-orch-enable=outside-repo:${trapSource}`);
      expect(check?.detail).toContain("警告:");
      expect(check?.ok).toBe(true);
      expect(result.ok).toBe(true);
      expect(ctx.exitCodes).toEqual([]);
    });

    it("repo内だが期待scriptと異なるシムはunexpected-sourceとして警告に含める", async () => {
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "unexpected-bin");
      const wrongSource = join(ctx.deps.orchestratorHelperRepoRoot as string, "scripts", "hachi-watchdog.sh");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "hhn"), `#!/bin/sh\nexec "${wrongSource}" "$@"\n`, { mode: 0o755 });
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain(`hhn=unexpected-source:${wrongSource}`);
    });

    it("symlinkが置かれていればnot-a-shim-fileとして警告に含める", async () => {
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "symlink-bin");
      mkdirSync(binDir, { recursive: true });
      const realSource = join(ctx.deps.orchestratorHelperRepoRoot as string, "scripts", "hachi-handover-now");
      symlinkSync(realSource, join(binDir, "hachi-handover-now"));
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain("hachi-handover-now=not-a-shim-file");
    });

    it("シム自身の実行権限が無ければshim-not-executableとして警告に含める（t_eac0371a7a1a368e）", async () => {
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "not-executable-shim-bin");
      mkdirSync(binDir, { recursive: true });
      const source = join(ctx.deps.orchestratorHelperRepoRoot as string, "scripts", "hachi-handover-now");
      // shim形式・解決先ともに正しいが、シム自身の実行bitだけ落ちている状態
      // （chmod -x 事故等）を再現する。
      writeFileSync(join(binDir, "hachi-handover-now"), `#!/bin/sh\nexec "${source}" "$@"\n`, { mode: 0o644 });
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain("hachi-handover-now=shim-not-executable");
    });

    it("解決先の実体scriptに実行権限が無ければsource-not-executableとして警告に含める（t_eac0371a7a1a368e）", async () => {
      ctx = createTestDeps();
      const repoRoot = join(ctx.deps.env.home, "no-exec-source-repo");
      mkdirSync(join(repoRoot, "scripts"), { recursive: true });
      const sourcePath = join(repoRoot, "scripts", "hachi-handover-now");
      // シム自身は実行可能だが、解決先の実体scriptだけ実行bitが落ちている状態
      // （原本を repo で chmod -x してしまった等）を再現する。シム経由の exec は
      // 解決先が実行不能だと `exec: Permission denied` になるため、doctor は
      // 解決先側の実行権限も見なければならない。
      writeFileSync(sourcePath, "#!/bin/bash\necho stub\n", { mode: 0o644 });
      const binDir = join(ctx.deps.env.home, "no-exec-source-bin");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(join(binDir, "hachi-handover-now"), `#!/bin/sh\nexec "${sourcePath}" "$@"\n`, { mode: 0o755 });
      ctx.deps.orchestratorHelperBinDir = binDir;
      ctx.deps.orchestratorHelperRepoRoot = repoRoot;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      expect(check?.detail).toContain("hachi-handover-now=source-not-executable");
    });

    it("1本だけ欠落していても警告の内訳に欠落シム名と残り4本のokが両方残る（警告化で内訳が失われないことの検証）", async () => {
      // 警告扱いに落としても、オーケストレーター運用者が「どのシムがどの状態で欠けているか」
      // を読めることが要件。1本 missing / 4本 ok の混在で内訳が両方出ることを固定する。
      ctx = createTestDeps();
      const binDir = join(ctx.deps.env.home, "one-missing-bin");
      const repoRoot = ctx.deps.orchestratorHelperRepoRoot as string;
      mkdirSync(binDir, { recursive: true });
      const handoverSource = join(repoRoot, "scripts", "hachi-handover-now");
      writeFileSync(join(binDir, "hachi-handover-now"), `#!/bin/sh\nexec "${handoverSource}" "$@"\n`, {
        mode: 0o755,
      });
      writeFileSync(join(binDir, "hhn"), `#!/bin/sh\nexec "${handoverSource}" "$@"\n`, { mode: 0o755 });
      const cacheTtlSource = join(repoRoot, "scripts", "orchestrator", "cc-cache-ttl");
      writeFileSync(join(binDir, "cc-cache-ttl"), `#!/bin/sh\nexec "${cacheTtlSource}" "$@"\n`, { mode: 0o755 });
      const watchStopSource = join(repoRoot, "scripts", "orchestrator", "hachi-watch-stop");
      writeFileSync(join(binDir, "hachi-watch-stop"), `#!/bin/sh\nexec "${watchStopSource}" "$@"\n`, { mode: 0o755 });
      // hachi-orch-enable だけ置かない
      ctx.deps.orchestratorHelperBinDir = binDir;

      await buildProgram(ctx.deps).parseAsync(["doctor", "--offline", "--json"], { from: "user" });

      const result = JSON.parse(ctx.stdout.text()) as { checks: DoctorCheckResult[]; ok: boolean };
      const check = result.checks.find((c) => c.name === "orchestrator helpers");
      expect(check?.ok).toBe(true);
      expect(check?.detail).toContain("警告:");
      // 欠落シム名が detail に出ること（警告化で最も失われやすい情報）
      expect(check?.detail).toContain("hachi-orch-enable=missing");
      // 残り4本の ok も同じ粒度で残ること
      expect(check?.detail).toContain("hachi-handover-now=ok");
      expect(check?.detail).toContain("hhn=ok");
      expect(check?.detail).toContain("cc-cache-ttl=ok");
      expect(check?.detail).toContain("hachi-watch-stop=ok");
      // binDir / repoRoot の文脈も残ること
      expect(check?.detail).toContain(`binDir=${binDir}`);
      expect(check?.detail).toContain(`repoRoot=${repoRoot}`);
      expect(result.ok).toBe(true);
      expect(ctx.exitCodes).toEqual([]);
    });
  });
});
