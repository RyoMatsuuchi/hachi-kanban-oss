// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeResourcesResponse } from "../../shared/api-types.js";
import { useRuntimeResources, type UseRuntimeResourcesResult } from "./use-runtime-resources.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let latest: UseRuntimeResourcesResult | null = null;

function Probe(): null {
  latest = useRuntimeResources();
  return null;
}

async function renderProbe(): Promise<{ root: Root; container: HTMLDivElement }> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  return { root, container };
}

function emptyResponse(): RuntimeResourcesResponse {
  return {
    generatedAt: 123,
    summary: {
      total: 0,
      byState: { requested: 0, provisioning: 0, active: 0, cleanup_pending: 0, expired: 0, releasing: 0, released: 0, quarantined: 0, failed: 0, cancelled: 0, unknown: 0 },
      active: 0,
      stale: 0,
      expired: 0,
      cleanupPending: 0,
      quarantined: 0,
      legacyNever: 0,
    },
    leases: [],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  latest = null;
  document.body.replaceChildren();
});

describe("useRuntimeResources", () => {
  it("正常 response を保持する", async () => {
    const fixture = emptyResponse();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 }))));
    const { root } = await renderProbe();
    await act(async () => Promise.resolve());
    expect(latest).toMatchObject({ data: fixture, error: null, degraded: false, loading: false });
    await act(async () => root.unmount());
  });

  it("503 を通常 error と区別して degraded にする", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 503 }))));
    const { root } = await renderProbe();
    await act(async () => Promise.resolve());
    expect(latest).toMatchObject({ data: null, degraded: true, loading: false });
    expect(latest?.error).toContain("503");
    await act(async () => root.unmount());
  });

  it("unmount 時に進行中 fetch を abort する", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const { root } = await renderProbe();
    expect(signal?.aborted).toBe(false);
    await act(async () => root.unmount());
    expect(signal?.aborted).toBe(true);
  });
});
