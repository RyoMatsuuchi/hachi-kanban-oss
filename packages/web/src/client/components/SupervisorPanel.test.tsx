// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeResourcesResponse, SupervisorStatus } from "../../shared/api-types.js";
import { SupervisorPanel } from "./SupervisorPanel.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const states = vi.hoisted(() => ({
  runtime: {
    data: null as RuntimeResourcesResponse | null,
    error: null as string | null,
    degraded: false,
    loading: true,
  },
}));

const supervisorStatus: SupervisorStatus = {
  launchd: null,
  stages: [],
  lastTick: null,
  killSwitchDir: "/tmp/hachi",
};

vi.mock("../hooks/use-supervisor-status.js", () => ({
  useSupervisorStatus: () => ({ data: supervisorStatus, error: null, loading: false, toggle: vi.fn() }),
}));

vi.mock("../hooks/use-runtime-resources.js", () => ({
  useRuntimeResources: () => states.runtime,
}));

function resourceFixture(): RuntimeResourcesResponse {
  const longId = `lease-${"a".repeat(90)}`;
  return {
    generatedAt: 1_700_000_100,
    summary: {
      total: 2,
      byState: { requested: 0, provisioning: 0, active: 2, cleanup_pending: 0, expired: 0, releasing: 0, released: 0, quarantined: 0, failed: 0, cancelled: 0, unknown: 0 },
      active: 1,
      stale: 1,
      expired: 0,
      cleanupPending: 1,
      quarantined: 0,
      legacyNever: 0,
    },
    leases: [
      {
        id: longId,
        bundleKind: "worktree_postgres",
        state: "active",
        ownerTaskId: `t_${"b".repeat(80)}`,
        ownerRunId: 42,
        controllerOrchestratorId: `orch-${"c".repeat(80)}`,
        fence: 9,
        heartbeatAt: 1_700_000_000,
        expiresAt: 1_700_000_090,
        stale: true,
        staleReasons: ["expiry_exceeded", "heartbeat_deadline_unknown"],
        cleanupPolicy: "auto",
        managed: true,
        ephemeral: true,
        terminalReason: "owner_terminal",
        members: [
          {
            id: `member-${"d".repeat(90)}`,
            kind: "docker_container",
            state: "active",
            objectFence: 4,
            display: `/very/long/worktree/path/${"segment/".repeat(20)}container`,
            port: { hostIp: "127.0.0.1", hostPort: 49152, containerPort: 5432 },
            managed: true,
            ephemeral: true,
            cleanupPolicy: "auto",
            provenanceRecorded: true,
            provenanceVerifiedAt: 1_700_000_010,
            lastObservedAt: 1_700_000_020,
            eligibility: {
              managed: "pass",
              ephemeral: "pass",
              cleanupPolicy: "pass",
              provenance: "pass",
              terminalOrExpired: "pass",
              leaseFence: "fail",
              memberSnapshot: "fail",
              unused: "unknown",
              freshInspect: "unknown",
              objectFence: "unknown",
              enforceMode: "unknown",
              killSwitch: "unknown",
              budget: "unknown",
              autoEligible: false,
              failedConditions: ["leaseFence:fail", "memberSnapshot:fail", "unused:unknown", "freshInspect:unknown"],
            },
          },
        ],
        cleanupRequests: [
          {
            id: "cleanup-1",
            decisionClass: "orchestrator",
            status: "waiting_human",
            reason: "explicit release review",
            expectedLeaseFence: 8,
            expectedMembersHash: "snapshot-hash",
            leaseFenceMatches: false,
            memberSnapshotMatches: false,
            claimantSessionId: "session-1",
            claimantGeneration: 2,
            claimLeaseUntil: 1_700_000_200,
            approvedBy: "",
            approvalGeneration: null,
            executorId: "",
            executorGeneration: 0,
            executorLeaseUntil: null,
            attempts: 2,
            nextAttemptAt: 1_700_000_300,
            lastError: "fence mismatch",
            escalationGeneration: 1,
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_020,
            resolvedAt: null,
          },
        ],
      },
      {
        id: "lease-second",
        bundleKind: "worktree_preview",
        state: "active",
        ownerTaskId: null,
        ownerRunId: null,
        controllerOrchestratorId: null,
        fence: 1,
        heartbeatAt: null,
        expiresAt: null,
        stale: false,
        staleReasons: [],
        cleanupPolicy: "never",
        managed: false,
        ephemeral: false,
        terminalReason: "",
        members: [],
        cleanupRequests: [],
      },
    ],
  };
}

interface RenderedPanel {
  container: HTMLDivElement;
  root: Root;
}

async function renderOpenPanel(): Promise<RenderedPanel> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SupervisorPanel />));
  const button = container.querySelector('button[aria-label="supervisor 状態"]');
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("supervisor button not found");
  }
  await act(async () => button.click());
  return { container, root };
}

afterEach(() => {
  states.runtime.data = null;
  states.runtime.error = null;
  states.runtime.degraded = false;
  states.runtime.loading = true;
  document.body.replaceChildren();
});

describe("SupervisorPanel resource health", () => {
  it("loading・empty・degraded/error を区別する", async () => {
    let rendered = await renderOpenPanel();
    expect(rendered.container.textContent).toContain("resource health を読み込み中");
    await act(async () => rendered.root.unmount());

    states.runtime.loading = false;
    states.runtime.data = {
      generatedAt: 1,
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
    rendered = await renderOpenPanel();
    expect(rendered.container.textContent).toContain("runtime resource lease はありません");
    await act(async () => rendered.root.unmount());

    states.runtime.data = null;
    states.runtime.error = "API リクエストに失敗しました (503)";
    states.runtime.degraded = true;
    rendered = await renderOpenPanel();
    expect(rendered.container.textContent).toContain("resource health API は未提供です");
    await act(async () => rendered.root.unmount());

    states.runtime.degraded = false;
    states.runtime.error = "network failed";
    rendered = await renderOpenPanel();
    expect(rendered.container.textContent).toContain("network failed");
    await act(async () => rendered.root.unmount());
  });

  it("複数 lease・cleanup request・failed evidence と長い値を折り畳み表示する", async () => {
    states.runtime.loading = false;
    states.runtime.data = resourceFixture();
    const { container, root } = await renderOpenPanel();
    const section = container.querySelector('[data-testid="runtime-resource-health"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("leases");
    expect(section?.textContent).toContain("cleanup 待ち");
    expect(section?.querySelectorAll('[data-testid="runtime-lease"]')).toHaveLength(2);
    expect(section?.querySelector('[data-testid="cleanup-request"]')?.textContent).toContain("fence mismatch");
    expect(section?.querySelector('[data-testid="runtime-eligibility"]')?.textContent).toContain("unused:unknown");
    expect(section?.textContent).toContain("heartbeat_deadline_unknown");
    expect(section?.querySelector("summary")?.className).toContain("[overflow-wrap:anywhere]");
    expect(section?.querySelector('[data-testid="runtime-resources-readonly"]')?.className).toContain("min-w-0");
    await act(async () => root.unmount());
  });

  it("resource health セクションには mutation control を置かない", async () => {
    states.runtime.loading = false;
    states.runtime.data = resourceFixture();
    const { container, root } = await renderOpenPanel();
    const section = container.querySelector('[data-testid="runtime-resource-health"]');
    expect(section?.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    expect(section?.querySelectorAll("details")).toHaveLength(2);
    await act(async () => root.unmount());
  });
});
