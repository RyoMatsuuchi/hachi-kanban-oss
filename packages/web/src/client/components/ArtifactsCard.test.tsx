// =============================================================================
// ArtifactsCard.tsx の run グルーピング・折りたたみ・絞り込みテスト（docs/contract.md §32.5）。
// =============================================================================

// @vitest-environment jsdom

import type { RunRow } from "@hachi/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactEntry } from "../../shared/api-types.js";
import { ArtifactsCard } from "./ArtifactsCard.js";

function makeArtifact(overrides: Partial<ArtifactEntry> & Pick<ArtifactEntry, "name">): ArtifactEntry {
  return {
    kind: "text",
    sizeBytes: 128,
    attachedAt: 1_780_000_000,
    attachedAtSource: "event",
    runId: null,
    sessionId: null,
    role: "unknown",
    attributionSource: "none",
    ...overrides,
    name: overrides.name,
  };
}

function makeRun(overrides: Partial<RunRow> & Pick<RunRow, "id" | "sessionId">): RunRow {
  return {
    taskId: "t_0000000000000001",
    provider: "codex",
    status: "done",
    meta: "{}",
    startedAt: 1_780_000_000,
    endedAt: 1_780_000_100,
    ...overrides,
    id: overrides.id,
    sessionId: overrides.sessionId,
  };
}

afterEach(() => {
  cleanup();
});

describe("ArtifactsCard", () => {
  it("グループと項目を新しい順に並べ、none を末尾にして最新グループだけを開く", () => {
    const artifactDetails = [
      makeArtifact({
        name: "old.txt",
        attachedAt: 1_780_000_100,
        runId: 111111111,
        sessionId: "session-old-12345678",
        role: "worker",
        attributionSource: "event-run",
      }),
      makeArtifact({
        name: "newer.png",
        kind: "image",
        attachedAt: 1_780_000_400,
        runId: 222222222,
        sessionId: "session-new-12345678",
        role: "reviewer",
        attributionSource: "event-run",
      }),
      makeArtifact({
        name: "newest.txt",
        attachedAt: 1_780_000_500,
        runId: 222222222,
        sessionId: "session-new-12345678",
        role: "reviewer",
        attributionSource: "event-run",
      }),
      makeArtifact({
        name: "session-only.txt",
        attachedAt: 1_780_000_300,
        sessionId: "session-mid-12345678",
        role: "rework",
        attributionSource: "filename-session",
      }),
      makeArtifact({
        name: "unattributed.txt",
        attachedAt: 1_780_000_900,
      }),
    ];
    const runs = [
      makeRun({ id: 111111111, sessionId: "session-old-12345678" }),
      makeRun({
        id: 222222222,
        sessionId: "session-new-12345678",
        provider: "claude",
        meta: JSON.stringify({ model: "claude-sonnet-5" }),
      }),
      makeRun({ id: 333333333, sessionId: "session-mid-12345678" }),
    ];

    const { container } = render(
      <ArtifactsCard
        taskId="t_0000000000000001"
        artifactDetails={artifactDetails}
        runs={runs}
      />,
    );
    const groups = Array.from(container.querySelectorAll<HTMLElement>("[data-artifact-group]"));

    expect(groups.map((group) => group.dataset.artifactGroup)).toEqual([
      "run:222222222",
      "session:session-mid-12345678",
      "run:111111111",
      "none",
    ]);
    expect(groups.map((group) => group.dataset.state)).toEqual(["open", "closed", "closed", "closed"]);
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(screen.getByText("claude / claude-sonnet-5")).toBeTruthy();

    const newestGroup = groups[0];
    if (newestGroup === undefined) {
      throw new Error("最新 artifact グループがありません");
    }
    expect(within(newestGroup).getAllByRole("link").map((link) => link.textContent?.trim())).toEqual([
      "newest.txt",
      "newer.png",
    ]);
  });

  it("すべて・最新の run・画像のみを切り替え、画像グループ構造と従来表示を維持する", () => {
    const artifactDetails = [
      makeArtifact({
        name: "latest image.png",
        kind: "image",
        sizeBytes: 2_048,
        attachedAt: 1_780_000_500,
        runId: 222222222,
        sessionId: "session-new-12345678",
        role: "worker",
        attributionSource: "event-run",
      }),
      makeArtifact({
        name: "latest.txt",
        attachedAt: 1_780_000_400,
        runId: 222222222,
        sessionId: "session-new-12345678",
        role: "worker",
        attributionSource: "event-run",
      }),
      makeArtifact({
        name: "older.png",
        kind: "image",
        attachedAt: 1_780_000_200,
        runId: 111111111,
        sessionId: "session-old-12345678",
        role: "worker",
        attributionSource: "event-run",
      }),
      makeArtifact({ name: "unattributed.txt", attachedAt: 1_780_000_900 }),
    ];

    const { container } = render(
      <ArtifactsCard taskId="t_0000000000000001" artifactDetails={artifactDetails} />,
    );
    expect(container.querySelectorAll("[data-artifact-group]")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "すべて" }).getAttribute("data-state")).toBe("on");

    fireEvent.click(screen.getByRole("radio", { name: "最新の run" }));
    expect(container.querySelectorAll("[data-artifact-group]")).toHaveLength(1);
    expect(screen.getByText("latest.txt")).toBeTruthy();
    expect(screen.queryByText("unattributed.txt")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "画像のみ" }));
    const imageGroups = Array.from(container.querySelectorAll<HTMLElement>("[data-artifact-group]"));
    expect(imageGroups.map((group) => group.dataset.artifactGroup)).toEqual([
      "run:222222222",
      "run:111111111",
    ]);
    expect(screen.queryByText("latest.txt")).toBeNull();
    const image = screen.getByRole("img", { name: "latest image.png" });
    expect(image.getAttribute("src")).toBe(
      "/task/t_0000000000000001/artifact/latest%20image.png",
    );
    expect(image.className).toContain("max-h-64");
    expect(image.className).toContain("object-contain");
    expect(image.closest("a")?.getAttribute("target")).toBe("_blank");
    expect(image.closest("ul")?.className).toContain("xl:grid-cols-3");
    expect(screen.getByText(/2,048 B/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "すべて" }));
    expect(container.querySelectorAll("[data-artifact-group]")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "すべて" }).getAttribute("data-state")).toBe("on");
  });
});
