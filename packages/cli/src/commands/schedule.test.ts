import { afterEach, describe, expect, it } from "vitest";
import type { ScheduleRow } from "@hachi/core";
import { buildProgram } from "../program.js";
import { createTestDeps, type TestDeps } from "../test-support.js";

describe("hachi schedule", () => {
  let ctx: TestDeps;

  afterEach(() => {
    ctx.cleanup();
  });

  it("create → list → show で schedule を操作できる", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      [
        "schedule",
        "create",
        "--name",
        "週次レビュー",
        "--cadence",
        "weekly",
        "--at",
        "09:30",
        "--weekday",
        "1",
        "--cwd",
        "/tmp/hk-scheduler",
        "--profile",
        "review",
        "--tenant",
        "dev",
        "--prompt",
        "レビューしてください",
        "--json",
      ],
      { from: "user" },
    );

    const createPayload = JSON.parse(ctx.stdout.text()) as { id: string; schedule: ScheduleRow };
    const created = createPayload.schedule;
    expect(createPayload.id).toBe(created.id);
    expect(createPayload).not.toHaveProperty("status");
    expect(created.id).toMatch(/^s_[0-9a-f]{16}$/);
    expect(created.name).toBe("週次レビュー");
    expect(created.cadenceKind).toBe("weekly");
    expect(created.weekday).toBe(1);
    expect(created.atHour).toBe(9);
    expect(created.atMinute).toBe(30);
    expect(created.cwd).toBe("/tmp/hk-scheduler");
    expect(created.profile).toBe("review");
    expect(created.tenant).toBe("dev");

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["schedule", "list", "--json"], { from: "user" });
    const listPayload = JSON.parse(ctx.stdout.text()) as { schedules: ScheduleRow[] };
    expect(listPayload).not.toHaveProperty("id");
    expect(listPayload).not.toHaveProperty("status");
    const listed = listPayload.schedules;
    expect(listed.map((schedule) => schedule.id)).toEqual([created.id]);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["schedule", "show", created.id, "--json"], { from: "user" });
    const showPayload = JSON.parse(ctx.stdout.text()) as { id: string; schedule: ScheduleRow };
    const shown = showPayload.schedule;
    expect(showPayload.id).toBe(shown.id);
    expect(showPayload).not.toHaveProperty("status");
    expect(shown.id).toBe(created.id);
    expect(shown.prompt).toBe("レビューしてください");
  });

  it("cwd が相対パスなら fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      [
        "schedule",
        "create",
        "--name",
        "bad",
        "--cadence",
        "daily",
        "--at",
        "09:00",
        "--cwd",
        "relative/path",
        "--prompt",
        "run",
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("cwd は絶対パスのみ指定できます");
    expect(ctx.deps.store.listSchedules()).toHaveLength(0);
  });

  it("未知 profile は作成前に fail-closed で拒否する", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      [
        "schedule",
        "create",
        "--name",
        "bad profile",
        "--cadence",
        "daily",
        "--at",
        "09:00",
        "--cwd",
        "/tmp/hk-scheduler",
        "--profile",
        "unknown-profile",
        "--prompt",
        "run",
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("未知の profile です: unknown-profile");
    expect(ctx.deps.store.listSchedules()).toHaveLength(0);
  });

  it("cadence ごとの必須オプション欠落を拒否する", async () => {
    ctx = createTestDeps();
    await buildProgram(ctx.deps).parseAsync(
      [
        "schedule",
        "create",
        "--name",
        "weekly without weekday",
        "--cadence",
        "weekly",
        "--at",
        "09:00",
        "--cwd",
        "/tmp/hk-scheduler",
        "--prompt",
        "run",
      ],
      { from: "user" },
    );

    expect(ctx.exitCodes).toEqual([1]);
    expect(ctx.stderr.text()).toContain("--weekday が必須です");
    expect(ctx.deps.store.listSchedules()).toHaveLength(0);
  });

  it("disable / enable / delete が KanbanStore 経由で反映される", async () => {
    ctx = createTestDeps();
    const schedule = ctx.deps.store.createSchedule(
      {
        name: "daily",
        cadenceKind: "daily",
        atHour: 10,
        atMinute: 0,
        cwd: "/tmp/hk-scheduler",
        prompt: "run",
      },
      "tester",
    );

    await buildProgram(ctx.deps).parseAsync(["schedule", "disable", schedule.id, "--json"], { from: "user" });
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      id: schedule.id,
      schedule: { id: schedule.id, enabled: false },
    });
    expect(ctx.deps.store.getSchedule(schedule.id)?.enabled).toBe(false);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["schedule", "enable", schedule.id, "--json"], { from: "user" });
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({
      id: schedule.id,
      schedule: { id: schedule.id, enabled: true },
    });
    expect(ctx.deps.store.getSchedule(schedule.id)?.enabled).toBe(true);

    ctx.stdout.clear();
    await buildProgram(ctx.deps).parseAsync(["schedule", "delete", schedule.id, "--json"], { from: "user" });
    expect(ctx.deps.store.getSchedule(schedule.id)).toBeNull();
    expect(JSON.parse(ctx.stdout.text())).toMatchObject({ id: schedule.id, deleted: true });
  });
});
