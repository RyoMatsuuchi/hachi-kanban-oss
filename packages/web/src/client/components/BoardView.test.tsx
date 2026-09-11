// =============================================================================
// BoardView のスモークテスト（docs/contract.md §11.x CI 導入に伴う最低限の描画検証）。
// =============================================================================

// @vitest-environment jsdom

import type { TaskRow } from "@hachi/core";
import type { BoardResponse } from "../../shared/api-types.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { waitFor, waitForElementToBeRemoved } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardView, type BoardViewProps } from "./BoardView.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function fixtureTask(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t_smoke",
    title: "スモークテスト用タスク",
    body: "本文",
    status: "ready",
    priority: 1,
    tenant: "dev",
    assignee: "",
    provider: "",
    profile: "implement",
    modelOverride: "",
    effortOverride: "",
    speedOverride: "",
    reviewProfileOverride: "",
    reviewProviderOverride: "",
    reviewModelOverride: "",
    reviewEffortOverride: "",
    reviewSpeedOverride: "",
    blockReason: "",
    claimLock: "",
    watched: false,
    consecutiveFailures: 0,
    lastFailureError: "",
    lastHeartbeatAt: null,
    maxRetries: 2,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function emptyBoardData(): BoardResponse {
  return {
    tenants: ["dev"],
    currentTenant: null,
    counts: {
      triage: 0,
      todo: 0,
      ready: 0,
      blocked: 0,
      review: 0,
      "needs-integration": 0,
      done: 0,
      archived: 0,
    },
    doneOrigins: {
      total: 0,
      counts: { gatePassed: 0, orchestratorHostFinalize: 0, humanDecision: 0, unknown: 0 },
      automaticCompletionRate: 0,
      manualRecoveryRate: 0,
      unknownRate: 0,
    },
    retryPending: 0,
    steerDeliveriesByTask: {},
    lanes: {
      humanQueue: [],
      humanDecisionQueue: [],
      orchestratorRecoveryQueue: [],
      inProgress: [],
      byStatus: {
        triage: [],
        todo: [],
        ready: [],
        review: [],
        "needs-integration": [],
        done: [],
      },
    },
  };
}

interface RenderedBoard {
  container: HTMLDivElement;
  root: Root;
}

const originalMatchMedia: typeof window.matchMedia | undefined = window.matchMedia;

function boardProps(props: Partial<BoardViewProps> = {}): BoardViewProps {
  return {
    data: emptyBoardData(),
    error: null,
    loading: false,
    bucket: "all" as const,
    onOpenTask: vi.fn(),
    watchedOnly: false,
    onToggleWatch: vi.fn(),
    ...props,
  };
}

async function renderBoard(props: Partial<BoardViewProps> = {}): Promise<RenderedBoard> {
  if (typeof window.matchMedia !== "function") {
    installMatchMedia(false);
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <BoardView {...boardProps(props)} />
        </MotionConfig>
      </LazyMotion>,
    );
    await Promise.resolve();
  });

  return { container, root };
}

async function rerenderBoard(rendered: RenderedBoard, props: Partial<BoardViewProps>): Promise<void> {
  await act(async () => {
    rendered.root.render(
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <BoardView {...boardProps(props)} />
        </MotionConfig>
      </LazyMotion>,
    );
    await Promise.resolve();
  });
}

function taskButton(container: ParentNode, taskId: string): HTMLButtonElement | null {
  const buttons = Array.from(container.querySelectorAll("button"));
  const button = buttons.find((element) => element.textContent?.includes(taskId) === true);
  return button instanceof HTMLButtonElement ? button : null;
}

function laneSection(container: ParentNode, title: string): HTMLElement {
  const section = Array.from(container.querySelectorAll("section")).find(
    (element) => element.querySelector("h2")?.textContent === title,
  );
  if (!(section instanceof HTMLElement)) {
    throw new Error(`lane section not found: ${title}`);
  }
  return section;
}

function laneCount(container: ParentNode, title: string): string {
  const section = laneSection(container, title);
  const chip = section.querySelector("header span");
  if (!(chip instanceof HTMLSpanElement)) {
    throw new Error(`lane count not found: ${title}`);
  }
  return chip.textContent ?? "";
}

function installMatchMedia(matchesReducedMotion: boolean): void {
  const matchMedia: typeof window.matchMedia = (query: string): MediaQueryList => {
    const target = new EventTarget();
    return {
      matches: query.includes("prefers-reduced-motion") ? matchesReducedMotion : false,
      media: query,
      onchange: null,
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target),
    };
  };

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("BoardView", () => {
  it("ローディング中は「読み込み中...」を表示する", async () => {
    const rendered = await renderBoard({ data: null, loading: true });

    expect(rendered.container.textContent).toContain("読み込み中...");
  });

  it("エラー時はエラーバナーを表示する", async () => {
    const rendered = await renderBoard({ error: "接続エラー" });

    expect(rendered.container.textContent).toContain("データ取得に失敗しました");
    expect(rendered.container.textContent).toContain("接続エラー");
  });

  it("空データで全レーンを描画する（クラッシュしない）", async () => {
    const rendered = await renderBoard();
    const main = rendered.container.querySelector("main");

    expect(main).not.toBeNull();
    // 人間確認キューは対応主体別の2レーンとして存在する
    expect(rendered.container.textContent).toContain("あなたの判断待ち");
    expect(rendered.container.textContent).toContain("あなたの回答・承認が必要です。");
    expect(rendered.container.textContent).toContain("オーケストレーター回収待ち");
    expect(rendered.container.textContent).toContain("自動処理の担当が回収します。通常は対応不要");
    expect(rendered.container.textContent).toContain("triage");
    expect(rendered.container.textContent).toContain("ready");
    expect(rendered.container.textContent).toContain("done");
  });

  it("タスクがあるレーンではタスクタイトルが表示される", async () => {
    const data = emptyBoardData();
    data.lanes.byStatus.ready = [fixtureTask({ id: "t_1", title: "実装タスクA" })];
    data.lanes.humanDecisionQueue = [fixtureTask({ id: "t_2", title: "判断待ちタスクB", status: "blocked" })];
    data.lanes.orchestratorRecoveryQueue = [
      fixtureTask({ id: "t_3", title: "回収待ちタスクC", status: "blocked" }),
    ];

    const rendered = await renderBoard({ data });

    expect(rendered.container.textContent).toContain("実装タスクA");
    expect(rendered.container.textContent).toContain("判断待ちタスクB");
    expect(rendered.container.textContent).toContain("回収待ちタスクC");
  });

  it("bucket='human_queue' でフィルタすると人間確認キュー2レーンのみ表示される", async () => {
    const data = emptyBoardData();
    data.lanes.humanDecisionQueue = [fixtureTask({ id: "t_hq", title: "HQタスク" })];
    data.lanes.byStatus.ready = [fixtureTask({ id: "t_r", title: "readyタスク" })];

    const rendered = await renderBoard({ data, bucket: "human_queue" });

    expect(rendered.container.textContent).toContain("HQタスク");
    expect(rendered.container.textContent).toContain("オーケストレーター回収待ち");
    // ready レーンはフィルタで非表示
    expect(rendered.container.textContent).not.toContain("readyタスク");
  });

  it("watchedOnly=true でウォッチ中のカードだけ表示する", async () => {
    const data = emptyBoardData();
    data.lanes.byStatus.ready = [
      fixtureTask({ id: "t_watch", title: "ウォッチ中", watched: true }),
      fixtureTask({ id: "t_plain", title: "通常タスク", watched: false }),
    ];

    const rendered = await renderBoard({ data, watchedOnly: true });

    expect(rendered.container.textContent).toContain("ウォッチ中");
    expect(rendered.container.textContent).not.toContain("通常タスク");
    expect(laneCount(rendered.container, "ready")).toBe("1");
  });

  it("データ更新でカード増加がDOMに反映される", async () => {
    const initial = emptyBoardData();
    const rendered = await renderBoard({ data: initial });

    expect(taskButton(rendered.container, "t_added")).toBeNull();

    const added = emptyBoardData();
    added.lanes.byStatus.ready = [fixtureTask({ id: "t_added", title: "追加タスク" })];
    await rerenderBoard(rendered, { data: added });

    await waitFor(() => {
      expect(taskButton(rendered.container, "t_added")).not.toBeNull();
    });
  });

  it("データ更新で件数チップが更新される", async () => {
    const initial = emptyBoardData();
    const rendered = await renderBoard({ data: initial });

    expect(laneCount(rendered.container, "ready")).toBe("0");

    const added = emptyBoardData();
    added.lanes.byStatus.ready = [fixtureTask({ id: "t_count", title: "件数対象タスク" })];
    await rerenderBoard(rendered, { data: added });

    await waitFor(() => {
      expect(laneCount(rendered.container, "ready")).toBe("1");
    });
  });

  it("カード削除は exit 後に DOM から消滅する", async () => {
    const initial = emptyBoardData();
    initial.lanes.byStatus.ready = [fixtureTask({ id: "t_remove", title: "削除されるタスク" })];
    const rendered = await renderBoard({ data: initial });

    expect(taskButton(rendered.container, "t_remove")).not.toBeNull();

    const empty = emptyBoardData();
    await rerenderBoard(rendered, { data: empty });

    await waitForElementToBeRemoved(() => taskButton(rendered.container, "t_remove"));
    expect(taskButton(rendered.container, "t_remove")).toBeNull();
  });

  it("同一タスクのポーリング更新でも経過時間表示を更新する", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(1_700_000_030_000));
    const onOpenTask = vi.fn();
    const data = emptyBoardData();
    data.lanes.byStatus.ready = [fixtureTask({ id: "t_elapsed", updatedAt: 1_700_000_000 })];
    const rendered = await renderBoard({ data, onOpenTask });

    expect(taskButton(rendered.container, "t_elapsed")?.textContent).toContain("30秒前");

    vi.setSystemTime(new Date(1_700_000_090_000));
    await rerenderBoard(rendered, { data, onOpenTask });

    expect(taskButton(rendered.container, "t_elapsed")?.textContent).toContain("1分前");
  });

});
