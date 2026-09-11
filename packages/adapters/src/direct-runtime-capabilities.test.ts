import { describe, expect, it } from "vitest";
import {
  DIRECT_SPEED_CONTROL_CAPABILITY,
  probeDirectRuntimeCapabilities,
  type DirectRuntimeCapabilityRunner,
  type DirectRuntimeCommandRequest,
  type DirectRuntimeCommandResult,
} from "./direct-runtime-capabilities.js";

class FakeRunner implements DirectRuntimeCapabilityRunner {
  requests: DirectRuntimeCommandRequest[] = [];

  constructor(private readonly result: DirectRuntimeCommandResult) {}

  run(request: DirectRuntimeCommandRequest): Promise<DirectRuntimeCommandResult> {
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

describe("probeDirectRuntimeCapabilities", () => {
  it.each([
    ["codex", "codex-cli 1.2.3"],
    ["claude", "2.0.0-beta.1+build.7 (Claude Code)"],
  ] as const)("%sのstrict semverをsnapshotへ正規化する", async (provider, stdout) => {
    const runner = new FakeRunner({ ok: true, stdout, stderr: "" });
    const result = await probeDirectRuntimeCapabilities({ provider, observedAt: 123 }, runner);
    expect(result).toMatchObject({
      ok: true,
      provider,
      snapshot: {
        provider,
        transport: "direct",
        runtime: { name: `${provider}-cli`, source: "local-probe" },
        modelCatalog: { knowledge: "unknown" },
        delivery: { model: "native", effort: "native" },
        observedAt: 123,
      },
    });
    expect(runner.requests).toEqual([{
      executable: provider,
      args: ["--version"],
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    }]);
  });

  it.each(["1.2", "v1.2.3", "1.02.3", "secret /Users/alice/token"])(
    "異形versionをsnapshotにせず構造化failureへ倒す: %s",
    async (stdout) => {
      const result = await probeDirectRuntimeCapabilities(
        { provider: "codex" },
        new FakeRunner({ ok: true, stdout, stderr: "" }),
      );
      expect(result).toEqual({
        ok: false,
        provider: "codex",
        failure: { kind: "invalid-output", detail: "runtime version is not strict semver" },
      });
      expect(JSON.stringify(result)).not.toContain(stdout);
    },
  );

  it.each(["not-found", "timeout", "execution"] as const)("runnerの%sを秘匿済みfailureにする", async (kind) => {
    const result = await probeDirectRuntimeCapabilities(
      { provider: "claude", executable: "/secret/home/claude", timeoutMs: 99_999 },
      new FakeRunner({ ok: false, kind }),
    );
    expect(result).toMatchObject({ ok: false, provider: "claude", failure: { kind } });
    expect(JSON.stringify(result)).not.toContain("/secret/home");
  });

  it("出力を上限で拒否しcatalogを捏造しない", async () => {
    const result = await probeDirectRuntimeCapabilities(
      { provider: "codex" },
      new FakeRunner({ ok: true, stdout: `codex 1.2.3 ${"x".repeat(4_096)}`, stderr: "" }),
    );
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-output" } });
  });

  it("runnerのthrowと非有限timeoutを安全に扱う", async () => {
    const runner: DirectRuntimeCapabilityRunner = {
      run: () => Promise.reject(new Error("/Users/alice/secret")),
    };
    const result = await probeDirectRuntimeCapabilities({ provider: "codex", timeoutMs: Number.NaN }, runner);
    expect(result).toEqual({
      ok: false,
      provider: "codex",
      failure: { kind: "execution", detail: "runtime version probe failed" },
    });
  });

  it.each([
    ["codex", "codex-cli 0.144.1"],
    ["codex", "codex-cli 1.0.0"],
    ["claude", "2.1.226 (Claude Code)"],
    ["claude", "3.0.0 (Claude Code)"],
  ] as const)("%sの確認済みruntime %s だけがspeed配送能力を広告する", async (provider, stdout) => {
    const result = await probeDirectRuntimeCapabilities(
      { provider },
      new FakeRunner({ ok: true, stdout, stderr: "" }),
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: {
        capabilities: [DIRECT_SPEED_CONTROL_CAPABILITY],
        delivery: { speed: "native" },
      },
    });
  });

  it.each([
    ["codex", "codex-cli 0.144.0"],
    ["codex", "codex-cli 0.144.1-beta.1"],
    ["claude", "2.1.225 (Claude Code)"],
    ["claude", "2.1.226-beta.1 (Claude Code)"],
  ] as const)("%sの未確認runtime %s はspeed能力を推測しない", async (provider, stdout) => {
    const result = await probeDirectRuntimeCapabilities(
      { provider },
      new FakeRunner({ ok: true, stdout, stderr: "" }),
    );
    expect(result).toMatchObject({
      ok: true,
      snapshot: { capabilities: [], delivery: { speed: "unknown" } },
    });
  });
});
