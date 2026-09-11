import { describe, expect, it } from "vitest";
import { countDirectResidualGroups, evaluateBridgeProcessHygiene, parseEtimeSeconds } from "./process-hygiene.js";
import type { ProcessEntry } from "./process-hygiene.js";

function proc(pid: number, ppid: number, etime: string, command: string, pgid = pid): ProcessEntry {
  return { pid, ppid, pgid, etime, startTime: `start-${pid}`, command };
}

describe("parseEtimeSeconds", () => {
  it("dd-hh:mm:ss / hh:mm:ss / mm:ss を秒へ変換する", () => {
    expect(parseEtimeSeconds("2-03:04:05")).toBe(183845);
    expect(parseEtimeSeconds("03:04:05")).toBe(11045);
    expect(parseEtimeSeconds("04:05")).toBe(245);
  });

  it("不正な etime は null を返す", () => {
    expect(parseEtimeSeconds("not-time")).toBeNull();
    expect(parseEtimeSeconds("01:99")).toBeNull();
    expect(parseEtimeSeconds("01:02:99")).toBeNull();
  });
});

describe("evaluateBridgeProcessHygiene", () => {
  it("app-server の子 codex の子孫だけを対象にし、閾値超過の top-level subtree を返す", () => {
    const report = evaluateBridgeProcessHygiene(
      [
        proc(10, 1, "01:00", "kanban-shared-app-server"),
        proc(20, 10, "01:00", "codex"),
        proc(30, 20, "02:31:00", "mcp-old-parent"),
        proc(31, 30, "02:31:00", "mcp-old-child"),
        proc(40, 20, "01:00", "mcp-young"),
        proc(50, 1, "10:00:00", "mcp-outside"),
      ],
      7200,
      50,
    );

    expect(report.failOpenReason).toBe("");
    expect(report.bridgeDescendantCount).toBe(3);
    expect(report.orphanCount).toBe(1);
    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.root.pid).toBe(30);
    expect(report.targets[0]?.pids).toEqual([31, 30]);
  });

  it("app-server または codex root が見つからない場合は fail-open で対象ゼロにする", () => {
    expect(evaluateBridgeProcessHygiene([], 7200, 50).failOpenReason).toBe("app-server-not-found");
    const noCodex = evaluateBridgeProcessHygiene(
      [proc(10, 1, "01:00", "kanban-shared-app-server"), proc(20, 10, "01:00", "node")],
      7200,
      50,
    );
    expect(noCodex.failOpenReason).toBe("codex-root-not-found");
    expect(noCodex.orphanCount).toBe(0);
  });

  it("閾値超過の codex app-server 本体と全子孫を回収対象から保護する", () => {
    const report = evaluateBridgeProcessHygiene(
      [
        proc(10, 1, "02:31:00", "kanban-shared-app-server"),
        proc(20, 10, "02:31:00", "even-terminal codex"),
        proc(30, 20, "02:31:00", "node codex app-server"),
        proc(31, 30, "02:31:00", "codex app-server"),
      ],
      7200,
      50,
    );

    expect(report.targets).toEqual([]);
  });

  it("閾値超過の無関係な子孫だけを回収対象にし、app-server を subtree に含めない", () => {
    const report = evaluateBridgeProcessHygiene(
      [
        proc(10, 1, "02:31:00", "kanban-shared-app-server"),
        proc(20, 10, "02:31:00", "even-terminal codex"),
        proc(40, 20, "02:31:00", "unrelated-worker"),
        proc(30, 40, "02:31:00", "node codex app-server"),
        proc(31, 30, "02:31:00", "codex app-server"),
      ],
      7200,
      50,
    );

    expect(report.targets).toHaveLength(1);
    expect(report.targets[0]?.root.pid).toBe(40);
    expect(report.targets[0]?.pids).toEqual([40]);
    expect(report.targets[0]?.pids).not.toContain(30);
    expect(report.targets[0]?.pids).not.toContain(31);
  });

  it("閾値未満の codex app-server と無関係な子孫は従来どおり回収対象にしない", () => {
    const report = evaluateBridgeProcessHygiene(
      [
        proc(10, 1, "02:29:59", "kanban-shared-app-server"),
        proc(20, 10, "02:29:59", "even-terminal codex"),
        proc(30, 20, "02:29:59", "node codex app-server"),
        proc(31, 30, "02:29:59", "codex app-server"),
        proc(40, 20, "02:29:59", "unrelated-worker"),
      ],
      7200,
      50,
    );

    expect(report.targets).toEqual([]);
  });

  it("回収対象は上限50件に制限する", () => {
    const processes = [
      proc(10, 1, "01:00", "kanban-shared-app-server"),
      proc(20, 10, "01:00", "codex"),
      ...Array.from({ length: 55 }, (_, index) => proc(100 + index, 20, "03:00:00", "mcp-old")),
    ];

    const report = evaluateBridgeProcessHygiene(processes, 7200, 50);
    expect(report.orphanCount).toBe(55);
    expect(report.targets).toHaveLength(50);
  });
});

describe("countDirectResidualGroups", () => {
  it("exit 済み direct state の pid が残っている group だけを数える", () => {
    const processes = [
      proc(101, 1, "01:00", "worker", 100),
      proc(201, 1, "01:00", "unrelated-worker", 999),
    ];
    expect(
      countDirectResidualGroups(processes, [
        { pid: 100, exitExists: true },
        { pid: 200, exitExists: true },
        { pid: 101, exitExists: false },
      ]),
    ).toBe(1);
  });
});
