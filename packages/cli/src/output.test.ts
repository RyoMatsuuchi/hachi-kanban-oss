import { describe, expect, it } from "vitest";
import { singularResourceEnvelope } from "./output.js";

describe("singularResourceEnvelope", () => {
  it("既存nested payloadを維持してid/statusを最上位へ複製する", () => {
    const task = { id: "t_example", status: "ready", title: "example" };
    const envelope = singularResourceEnvelope(task, { task, extra: true });

    expect(envelope).toEqual({
      task,
      extra: true,
      id: "t_example",
      status: "ready",
    });
    expect(envelope.task).toBe(task);
  });

  it("statusを持たないresourceにはidだけを加え、値を推測しない", () => {
    const schedule = { id: "s_example", enabled: true };
    const envelope = singularResourceEnvelope(schedule, { schedule });

    expect(envelope).toEqual({
      schedule,
      id: "s_example",
    });
    expect(envelope).not.toHaveProperty("status");
  });
});
