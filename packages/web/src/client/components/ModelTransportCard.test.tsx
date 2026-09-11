// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { EventRow } from "@hachi/core";
import { ModelTransportCard } from "./ModelTransportCard.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

function event(
  payload: unknown,
  id = 1,
  eventType = "incompatible_model_transport",
): EventRow {
  return {
    id,
    taskId: "t_0000000000000001",
    eventType,
    actor: "supervisor",
    payload: JSON.stringify(payload),
    provenance: { kind: "unknown", actorId: "", actorSessionId: "", actorGeneration: null },
    createdAt: 1_700_000_000,
  };
}

async function render(events: EventRow[]): Promise<string> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<ModelTransportCard events={events} />));
  return container.textContent ?? "";
}

describe("ModelTransportCard", () => {
  it("unsupportedの期待値・実広告・理由を表示する", async () => {
    const text = await render([event({
      provider: "codex",
      model: "gpt-5.6-sol",
      transport: "bridge",
      status: "unsupported",
      reason: "runtime-version-too-old",
      detail: "runtime=0.143.0, minimum=0.144.1",
      expectation: { minimumRuntimeVersion: "0.144.1" },
      observed: {
        runtime: { name: "bridge-codex", version: "0.143.0", source: "advertised" },
        capabilities: ["model-passthrough-v1"],
        modelCatalog: { knowledge: "unknown" },
        delivery: { model: "native", effort: "none" },
      },
    })]);

    expect(text).toContain("unsupported");
    expect(text).toContain("0.144.1");
    expect(text).toContain("bridge-codex @ 0.143.0");
    expect(text).toContain("runtime-version-too-old");
  });

  it("観測がないunknownをsupportedに見せない", async () => {
    const text = await render([event({
      provider: "claude",
      model: "claude-sonnet-5",
      transport: "bridge",
      status: "unknown",
      reason: "capability-probe-failed",
      detail: "timeout",
      expectation: {},
      observed: null,
    })]);

    expect(text).toContain("unknown");
    expect(text).not.toContain("supported");
    expect(text).toContain("不明 @ 不明");
  });

  it("ASC履歴の末尾にあるbridge更新後のsupported判定を表示する", async () => {
    const text = await render([
      event({
        provider: "codex",
        model: "gpt-5.6-sol",
        transport: "bridge",
        status: "unsupported",
        reason: "runtime-version-too-old",
        detail: "runtime=0.143.0, minimum=0.144.1",
        expectation: { minimumRuntimeVersion: "0.144.1" },
        observed: {
          runtime: { name: "bridge-codex", version: "0.143.0", source: "advertised" },
          capabilities: [],
          modelCatalog: { knowledge: "unknown" },
          delivery: { model: "native", effort: "native" },
        },
      }, 1),
      event({
        provider: "codex",
        model: "gpt-5.6-sol",
        transport: "bridge",
        status: "supported",
        evidence: "runtime-version-policy",
        expectation: { minimumRuntimeVersion: "0.144.1" },
        observed: {
          runtime: { name: "bridge-codex", version: "0.144.1", source: "advertised" },
          capabilities: [],
          modelCatalog: { knowledge: "unknown" },
          delivery: { model: "native", effort: "native" },
        },
      }, 2, "model_transport_compatibility_checked"),
    ]);

    expect(text).toContain("supported");
    expect(text).toContain("bridge-codex @ 0.144.1");
    expect(text).not.toContain("unsupported");
    expect(text).not.toContain("0.143.0");
  });
});
