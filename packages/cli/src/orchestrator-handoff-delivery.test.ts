// =============================================================================
// transcript 送達ゲートと Claude cwd trust probe の単体テスト。
// 実 tmux / claude は起動せず、一時ファイルだけで観測契約を固定する。
// =============================================================================

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createClaudeTrustProbeForConfig,
  defaultClaudeTrustProbe,
  defaultHandoverDeliveryGateProbe,
} from "./orchestrator-handoff-delivery.js";

describe("defaultHandoverDeliveryGateProbe", () => {
  let projectsRoot: string;

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "hachi-handoff-delivery-"));
  });

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  function writeSessionLog(sessionId: string, rows: string[]): void {
    const projectDir = join(projectsRoot, "-Users-tester-worktree");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${rows.join("\n")}\n`, "utf8");
  }

  it("jsonl ファイルが存在するだけでは送達済みにしない", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeSessionLog(sessionId, []);

    const observation = await defaultHandoverDeliveryGateProbe({
      claudeProjectsRoot: projectsRoot,
      successorSessionId: sessionId,
      launchNonce: "expected-nonce",
    });

    expect(observation).toEqual({ userNonceObserved: false, assistantObserved: false });
  });

  it("user 行に期待 nonce があっても assistant 行が無ければ1段目だけを満たす", async () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    writeSessionLog(sessionId, [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "launch nonce: expected-nonce\nstart" },
      }),
    ]);

    const observation = await defaultHandoverDeliveryGateProbe({
      claudeProjectsRoot: projectsRoot,
      successorSessionId: sessionId,
      launchNonce: "expected-nonce",
    });

    expect(observation).toEqual({ userNonceObserved: true, assistantObserved: false });
  });

  it("nonce 一致 user 行より後の assistant 行で2段階ゲートを満たす", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    writeSessionLog(sessionId, [
      JSON.stringify({ type: "user", message: { content: "別の起動プロンプト" } }),
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "launch nonce: expected-nonce" }] },
      }),
      JSON.stringify({ type: "assistant", message: { content: "開始" } }),
    ]);

    const observation = await defaultHandoverDeliveryGateProbe({
      claudeProjectsRoot: projectsRoot,
      successorSessionId: sessionId,
      launchNonce: "expected-nonce",
    });

    expect(observation).toEqual({ userNonceObserved: true, assistantObserved: true });
  });

  it("assistant が nonce 一致 user より前にあるだけなら2段目を満たさない", async () => {
    const sessionId = "44444444-4444-4444-8444-444444444444";
    writeSessionLog(sessionId, [
      JSON.stringify({ type: "assistant", message: { content: "先行行" } }),
      JSON.stringify({ type: "user", message: { content: "launch nonce: expected-nonce" } }),
    ]);

    const observation = await defaultHandoverDeliveryGateProbe({
      claudeProjectsRoot: projectsRoot,
      successorSessionId: sessionId,
      launchNonce: "expected-nonce",
    });

    expect(observation).toEqual({ userNonceObserved: true, assistantObserved: false });
  });

  it("不一致 nonce と破損行を送達証拠にしない", async () => {
    const sessionId = "55555555-5555-4555-8555-555555555555";
    writeSessionLog(sessionId, [
      "{ broken",
      JSON.stringify({ type: "user", message: { content: "launch nonce: other-nonce" } }),
      JSON.stringify({ type: "assistant", message: { content: "開始" } }),
    ]);

    const observation = await defaultHandoverDeliveryGateProbe({
      claudeProjectsRoot: projectsRoot,
      successorSessionId: sessionId,
      launchNonce: "expected-nonce",
    });

    expect(observation).toEqual({ userNonceObserved: false, assistantObserved: false });
  });
});

describe("ClaudeTrustProbe", () => {
  let configDir: string;
  let configPath: string;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "hachi-claude-trust-"));
    configPath = join(configDir, ".claude.json");
    originalConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env["CLAUDE_CONFIG_DIR"];
    } else {
      process.env["CLAUDE_CONFIG_DIR"] = originalConfigDir;
    }
  });

  it("projects[cwd].hasTrustDialogAccepted が true の場合だけ trusted とする", () => {
    const cwd = "/Users/tester/repo";
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
      "utf8",
    );

    expect(createClaudeTrustProbeForConfig(configPath).isTrusted(cwd)).toBe(true);
  });

  it("false・未登録・壊れた設定を fail-closed で untrusted とする", () => {
    const cwd = "/Users/tester/repo";
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: false } } }),
      "utf8",
    );
    const probe = createClaudeTrustProbeForConfig(configPath);
    expect(probe.isTrusted(cwd)).toBe(false);
    expect(probe.isTrusted("/Users/tester/other")).toBe(false);

    writeFileSync(configPath, "{ broken", "utf8");
    expect(probe.isTrusted(cwd)).toBe(false);
  });

  it("default probe は CLAUDE_CONFIG_DIR を呼出し時に解決する", () => {
    const cwd = "/Users/tester/repo";
    writeFileSync(
      configPath,
      JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }),
      "utf8",
    );
    process.env["CLAUDE_CONFIG_DIR"] = configDir;

    expect(defaultClaudeTrustProbe.isTrusted(cwd)).toBe(true);
  });
});
