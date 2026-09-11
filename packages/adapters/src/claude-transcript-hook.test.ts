import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_STOP_HOOK_SCHEMA,
  CLAUDE_STOP_MAX_TRANSCRIPT_BYTES,
  buildClaudeStopHookSettings,
  captureClaudeStopHookInput,
  claudeTranscriptHookPaths,
  installClaudeTranscriptHook,
  readClaudeTranscriptCapture,
} from "./claude-transcript-hook.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function providerTranscriptRoot(root: string): string {
  const path = join(root, "provider-transcripts");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function runHook(scriptPath: string, input: unknown): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code: number | null) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("Claude public Stop hook transcript capture", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot !== undefined) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it("installs a process-local hook setting with shell-safe command and exact paths", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = installClaudeTranscriptHook(tempRoot, SESSION_ID, transcriptRoot);
    const otherPaths = claudeTranscriptHookPaths(tempRoot, "22222222-2222-4222-8222-222222222222", transcriptRoot);
    expect(otherPaths.scriptPath).not.toBe(paths.scriptPath);
    const settings = buildClaudeStopHookSettings(paths, "/tmp/node with space");
    expect(settings.hooks.Stop[0]?.hooks[0]?.type).toBe("command");
    expect(settings.hooks.StopFailure[0]?.hooks[0]?.command).toBe(settings.hooks.Stop[0]?.hooks[0]?.command);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toContain("'/tmp/node with space'");
    expect(readFileSync(paths.scriptPath, "utf8")).toContain(SESSION_ID);
    expect(statSync(paths.scriptPath).mode & 0o777).toBe(0o700);
  });

  it("captures transcript and last assistant result atomically with exact session binding", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = claudeTranscriptHookPaths(join(tempRoot, "state"), SESSION_ID, transcriptRoot);
    const source = join(transcriptRoot, "provider-transcript.jsonl");
    writeFileSync(source, "assistant: done\n", "utf8");
    chmodSync(source, 0o600);
    const result = captureClaudeStopHookInput(paths, {
      session_id: SESSION_ID,
      transcript_path: source,
      last_assistant_message: "done",
    }, 123);
    expect(result.artifact).toMatchObject({
      schemaVersion: CLAUDE_STOP_HOOK_SCHEMA,
      sessionId: SESSION_ID,
      outcome: "captured",
      capturedAt: 123,
      transcriptBytes: 16,
    });
    expect(readClaudeTranscriptCapture(join(tempRoot, "state"), SESSION_ID)).toBe("assistant: done\n");
    expect(statSync(paths.transcriptPath).mode & 0o777).toBe(0o600);
    expect(statSync(paths.resultPath).mode & 0o777).toBe(0o600);
  });

  it("standalone hook process uses only stdin JSON and emits no transcript/secret logs", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = installClaudeTranscriptHook(join(tempRoot, "state"), SESSION_ID, transcriptRoot);
    const source = join(transcriptRoot, "provider-transcript.jsonl");
    writeFileSync(source, "private assistant result\n", "utf8");
    chmodSync(source, 0o600);
    const processResult = await runHook(paths.scriptPath, {
      session_id: SESSION_ID,
      transcript_path: source,
      last_assistant_message: "private assistant result",
    });
    expect(processResult.code).toBe(0);
    expect(processResult.stdout).toBe("");
    expect(processResult.stderr).toBe("");
    expect(readClaudeTranscriptCapture(join(tempRoot, "state"), SESSION_ID)).toContain("private assistant result");
  });

  it("standalone hook は 300KiB の last_assistant_message 本文を failure artifact に保存しない", async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = installClaudeTranscriptHook(join(tempRoot, "state"), SESSION_ID, transcriptRoot);
    const source = join(transcriptRoot, "provider-transcript.jsonl");
    writeFileSync(source, "transcript is not captured when the last message is oversized\n", "utf8");
    chmodSync(source, 0o600);
    const marker = "OVERSIZED-LAST-ASSISTANT-MESSAGE-SECRET";
    const oversizedMessage = `${"x".repeat((300 * 1024) - marker.length)}${marker}`;
    const processResult = await runHook(paths.scriptPath, {
      session_id: SESSION_ID,
      transcript_path: source,
      last_assistant_message: oversizedMessage,
    });
    expect(processResult.code).toBe(0);
    expect(processResult.stdout).toBe("");
    expect(processResult.stderr).toBe("");
    const resultRaw = readFileSync(paths.resultPath, "utf8");
    const result = JSON.parse(resultRaw) as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: CLAUDE_STOP_HOOK_SCHEMA,
      sessionId: SESSION_ID,
      outcome: "failed",
      failureCode: "size-limit",
      lastAssistantMessageBytes: Buffer.byteLength(oversizedMessage, "utf8"),
    });
    expect(result).not.toHaveProperty("lastAssistantMessage");
    expect(resultRaw).not.toContain(marker);
    expect(Buffer.byteLength(resultRaw, "utf8")).toBeLessThan(4096);
    expect(statSync(paths.resultPath).mode & 0o777).toBe(0o600);
  });

  it("rejects session mismatch, symlink transcript, and oversized transcript fail-closed", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const stateDir = join(tempRoot, "state");
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = claudeTranscriptHookPaths(stateDir, SESSION_ID, transcriptRoot);
    const source = join(transcriptRoot, "provider-transcript.jsonl");
    writeFileSync(source, "safe\n", "utf8");
    chmodSync(source, 0o600);
    expect(() => captureClaudeStopHookInput(paths, {
      session_id: "22222222-2222-4222-8222-222222222222",
      transcript_path: source,
    })).toThrow(/exact provider session/);

    const symlink = join(transcriptRoot, "transcript-link");
    symlinkSync(source, symlink);
    const symlinkResult = captureClaudeStopHookInput(paths, { session_id: SESSION_ID, transcript_path: symlink });
    expect(symlinkResult.artifact.outcome).toBe("failed");

    const oversized = join(transcriptRoot, "oversized");
    writeFileSync(oversized, Buffer.alloc(CLAUDE_STOP_MAX_TRANSCRIPT_BYTES + 1, 0x61));
    chmodSync(oversized, 0o600);
    const oversizedResult = captureClaudeStopHookInput(paths, { session_id: SESSION_ID, transcript_path: oversized });
    expect(oversizedResult.artifact).toMatchObject({ outcome: "failed", failureCode: "size-limit" });
    chmodSync(paths.resultPath, 0o600);
  });

  it("accepts only canonical regular files owned by the current user under the provider root", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = claudeTranscriptHookPaths(join(tempRoot, "state"), SESSION_ID, transcriptRoot);
    const outside = join(tempRoot, "outside-transcript.jsonl");
    writeFileSync(outside, "outside\n", "utf8");
    const outsideResult = captureClaudeStopHookInput(paths, { session_id: SESSION_ID, transcript_path: outside });
    expect(outsideResult.artifact).toMatchObject({ outcome: "failed", failureCode: "unsafe-transcript-path" });

    const writable = join(transcriptRoot, "group-writable.jsonl");
    writeFileSync(writable, "unsafe\n", "utf8");
    chmodSync(writable, 0o666);
    const writableResult = captureClaudeStopHookInput(paths, { session_id: SESSION_ID, transcript_path: writable });
    expect(writableResult.artifact).toMatchObject({ outcome: "failed", failureCode: "unsafe-transcript-path" });
  });

  it("captures StopFailure metadata when transcript_path is missing", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const stateDir = join(tempRoot, "state");
    const paths = claudeTranscriptHookPaths(stateDir, SESSION_ID, providerTranscriptRoot(tempRoot));
    const result = captureClaudeStopHookInput(paths, {
      session_id: SESSION_ID,
      last_assistant_message: "last message",
    });
    expect(result.artifact).toMatchObject({ outcome: "failed", failureCode: "capture-failed" });
    expect(() => readClaudeTranscriptCapture(stateDir, SESSION_ID)).toThrow(/capture failed/);
  });

  it("captures StopFailure error code without persisting the provider error text", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const stateDir = join(tempRoot, "state");
    const transcriptRoot = providerTranscriptRoot(tempRoot);
    const paths = claudeTranscriptHookPaths(stateDir, SESSION_ID, transcriptRoot);
    const source = join(transcriptRoot, "provider-transcript.jsonl");
    writeFileSync(source, "error transcript\n", "utf8");
    chmodSync(source, 0o600);
    const result = captureClaudeStopHookInput(paths, {
      session_id: SESSION_ID,
      transcript_path: source,
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "sensitive provider detail",
      last_assistant_message: "API Error: sensitive provider detail",
    });
    expect(result.artifact).toMatchObject({ outcome: "failed", failureCode: "stop-failure:rate_limit" });
    expect(readFileSync(paths.resultPath, "utf8")).not.toContain("sensitive provider detail");
    expect(readClaudeTranscriptCapture(stateDir, SESSION_ID)).toBe("error transcript\n");
  });

  it("keeps StopFailure code when transcript capture itself fails", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "hachi-claude-stop-hook-"));
    const stateDir = join(tempRoot, "state");
    const paths = claudeTranscriptHookPaths(stateDir, SESSION_ID, providerTranscriptRoot(tempRoot));
    const result = captureClaudeStopHookInput(paths, {
      session_id: SESSION_ID,
      hook_event_name: "StopFailure",
      error: "authentication_failed",
      error_details: "secret detail",
      last_assistant_message: "secret error text",
    });
    expect(result.artifact).toMatchObject({ outcome: "failed", failureCode: "stop-failure:authentication_failed" });
    expect(readFileSync(paths.resultPath, "utf8")).not.toContain("secret error text");
  });
});
