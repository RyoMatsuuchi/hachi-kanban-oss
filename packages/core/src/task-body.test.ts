import { describe, expect, it } from "vitest";
import {
  assertTaskBodyValid,
  extractTaskBodyCwd,
  findTaskBodyValidationError,
  TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
} from "./task-body.js";

describe("task body validation", () => {
  it("cwd と section が literal newline escape で同じ物理行に埋め込まれている本文を検出する", () => {
    const error = findTaskBodyValidationError("cwd: /tmp\\n## 目的\\n本文");

    expect(error).not.toBeNull();
    expect(error).toMatchObject({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      details: {
        code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
        escape: "\\n",
        physicalLine: 1,
        logicalLineCount: 3,
        trigger: "cwd",
      },
    });
  });

  it("literal CRLF escape も同じ code/details 契約で検出する", () => {
    const error = findTaskBodyValidationError("cwd: /tmp\\r\\n本文");

    expect(error).toMatchObject({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      details: {
        escape: "\\r\\n",
        physicalLine: 1,
        logicalLineCount: 2,
        trigger: "cwd",
      },
    });
  });

  it("JSON.stringify の外側引用符付き入力も検出する", () => {
    const error = findTaskBodyValidationError(`${JSON.stringify("cwd: /tmp\n本文")}\n`);

    expect(error).toMatchObject({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      details: {
        escape: "\\n",
        physicalLine: 1,
        logicalLineCount: 2,
        trigger: "cwd",
      },
    });
  });

  it("cwd が無くても複数行相当の section を検出する", () => {
    const error = findTaskBodyValidationError("## 目的\\n本文\\n## Scope");

    expect(error?.details.trigger).toBe("multiple-lines");
  });

  it("2論理行だけの collapsed section も検出する", () => {
    const error = findTaskBodyValidationError("## 目的\\n本文");

    expect(error).toMatchObject({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      details: {
        logicalLineCount: 2,
        trigger: "multiple-lines",
      },
    });
  });

  it("escape の直後に空白が続く collapsed section も検出する", () => {
    const error = findTaskBodyValidationError("## 目的\\n  本文");

    expect(error).toMatchObject({
      code: TASK_BODY_LITERAL_NEWLINE_ESCAPE_CODE,
      details: {
        escape: "\\n",
        physicalLine: 1,
        logicalLineCount: 2,
        trigger: "multiple-lines",
      },
    });
  });

  it("escape の直後に空白が続く CRLF 版も検出する", () => {
    const error = findTaskBodyValidationError("## 目的\\r\\n  本文");

    expect(error).toMatchObject({
      details: { escape: "\\r\\n", trigger: "multiple-lines" },
    });
  });

  it("escape の直前に markdown hard break の行末空白が付く collapsed section も検出する", () => {
    // JSON.stringify 由来の本文では、見出し行末の hard break（空白2つ）がそのまま escape の直前に残る。
    expect(findTaskBodyValidationError("## 目的  \\n本文")).toMatchObject({
      details: { escape: "\\n", physicalLine: 1, logicalLineCount: 2, trigger: "multiple-lines" },
    });
    expect(findTaskBodyValidationError("## 目的 \\n本文")?.details.trigger).toBe("multiple-lines");
    expect(findTaskBodyValidationError("## 目的  \\r\\n本文")?.details.escape).toBe("\\r\\n");
    expect(findTaskBodyValidationError("## 目的  \\n本文  \\n## Scope")).toMatchObject({
      details: { logicalLineCount: 3, trigger: "multiple-lines" },
    });
  });

  it("escape の直後に空白が続く cwd 行を末尾実改行付きでも検出する", () => {
    const error = findTaskBodyValidationError("cwd: /tmp\\n## 目的\\n  本文\n");

    expect(error).toMatchObject({
      details: {
        escape: "\\n",
        physicalLine: 1,
        logicalLineCount: 3,
        trigger: "cwd",
      },
    });
    expect(extractTaskBodyCwd("cwd: /tmp\\n## 目的\\n  本文\n")).toBeNull();
  });

  it("Windows path の区切り backslash を含む見出しは誤拒否しない", () => {
    expect(findTaskBodyValidationError("## Windows path C:\\new\\name")).toBeNull();

    const body = "cwd: /tmp\n## Windows path C:\\new\\name\n本文";
    expect(findTaskBodyValidationError(body)).toBeNull();
    expect(extractTaskBodyCwd(body)).toBe("/tmp");
  });

  it("UNC path と単一区切りの Windows path も誤拒否しない", () => {
    expect(findTaskBodyValidationError("cwd: /tmp\n## Path C:\\name\n本文")).toBeNull();
    expect(findTaskBodyValidationError("cwd: /tmp\n## Share \\\\server\\share\\new\n本文")).toBeNull();
  });

  it("escape 済み backslash (`\\\\n`) は改行として扱わない", () => {
    expect(findTaskBodyValidationError("cwd: /tmp\n## 目的\\\\n本文\n本文")).toBeNull();
  });

  it("section見出し内の複数literal escape表記は誤拒否しない", () => {
    const body = "cwd: /tmp\n## 目的: literal \\n 表記と literal \\r\\n 表記\n本文";

    expect(findTaskBodyValidationError(body)).toBeNull();
  });

  it("inline code内の複数literal escape表記も誤拒否しない", () => {
    const body = "cwd: /tmp\n## 目的: `literal \\n` と `literal \\r\\n`\n本文";

    expect(findTaskBodyValidationError(body)).toBeNull();
  });

  it("実改行bodyのsection見出し内にある意図的なliteral newline表記は受理する", () => {
    const body = "cwd: /tmp\n## 目的: literal \\n 表記\n本文";

    expect(findTaskBodyValidationError(body)).toBeNull();
    expect(extractTaskBodyCwd(body)).toBe("/tmp");
  });

  it("実改行と意図的な通常 backslash は受理し、自動変換しない", () => {
    const body = "cwd: /tmp\n- 本文には文字列 \\n と \\r\\n をそのまま残す\n- 別の \\n 表記";

    expect(findTaskBodyValidationError(body)).toBeNull();
    expect(() => assertTaskBodyValid(body)).not.toThrow();
    expect(body).toContain("\\n");
    expect(extractTaskBodyCwd(body)).toBe("/tmp");
  });

  it("literal escape の本文は cwd parser でも独立行にならない", () => {
    expect(extractTaskBodyCwd("cwd: /tmp\\n本文")).toBeNull();
    expect(extractTaskBodyCwd("cwd: /tmp\n本文")).toBe("/tmp");
  });
});
