// =============================================================================
// TaskDetailView.tsx の取得失敗・not found 表示分岐テスト。
// =============================================================================

// @vitest-environment jsdom

import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRow } from "@hachi/core";
import type { NormalizedTaskDetailResponse } from "../../shared/api-types.js";
import type { TaskDetailViewProps } from "./TaskDetailView.js";

interface MockHumanDecisionsPanelProps {
  taskId?: string;
  tenant?: string;
  onOpenTask: (taskId: string) => void;
}

interface MockTaskDetailResult {
  data: NormalizedTaskDetailResponse | null;
  error: string | null;
  loading: boolean;
  updateTask: (task: TaskRow) => void;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const useTaskDetailMock = vi.hoisted(() => vi.fn<(taskId: string) => MockTaskDetailResult>());
const humanDecisionsPanelMock = vi.hoisted(() => vi.fn<(props: MockHumanDecisionsPanelProps) => void>());

vi.mock("../hooks/use-task-detail.js", () => ({
  useTaskDetail: useTaskDetailMock,
}));

vi.mock("./HumanDecisionsPanel.js", () => ({
  HumanDecisionsPanel: (props: MockHumanDecisionsPanelProps): JSX.Element => {
    humanDecisionsPanelMock(props);
    return <section data-testid="human-decisions-panel" />;
  },
}));

import { TaskDetailView } from "./TaskDetailView.js";

interface RenderedTaskDetailView {
  container: HTMLDivElement;
  root: Root;
  rerender: (result: MockTaskDetailResult, props: TaskDetailViewProps) => Promise<void>;
}

function makeTask(title: string): TaskRow {
  return {
    id: "t_0000000000000001",
    title,
    body: "cwd: /tmp",
    status: "ready",
    priority: 0,
    tenant: "dev",
    assignee: "",
    provider: "",
    profile: "",
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
    maxRetries: 3,
    createdAt: 1,
    updatedAt: 1,
    startedAt: null,
    completedAt: null,
  };
}

async function renderTaskDetailView(
  result: MockTaskDetailResult,
  props: TaskDetailViewProps = {
    taskId: "t_0000000000000001",
    onOpenTask: () => undefined,
  },
): Promise<RenderedTaskDetailView> {
  useTaskDetailMock.mockReturnValue(result);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<TaskDetailView {...props} />);
    await Promise.resolve();
  });
  return {
    container,
    root,
    rerender: async (nextResult: MockTaskDetailResult, nextProps: TaskDetailViewProps): Promise<void> => {
      useTaskDetailMock.mockReturnValue(nextResult);
      await act(async () => {
        root.render(<TaskDetailView {...nextProps} />);
        await Promise.resolve();
      });
    },
  };
}

afterEach(() => {
  useTaskDetailMock.mockReset();
  humanDecisionsPanelMock.mockReset();
  document.body.innerHTML = "";
});

describe("TaskDetailView", () => {
  it("取得失敗時はエラーだけを表示し not found を表示しない", async () => {
    const rendered = await renderTaskDetailView({
      data: null,
      error: "network error",
      loading: false,
      updateTask: () => undefined,
    });
    const text = rendered.container.textContent ?? "";

    expect(text).toContain("データ取得に失敗しました: network error");
    expect(text).not.toContain("タスクが見つかりません");
    expect(rendered.container.querySelector('[data-testid="human-decisions-panel"]')).toBeNull();
    expect(humanDecisionsPanelMock).not.toHaveBeenCalled();

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("取得成功後に task が無い場合だけ not found を表示する", async () => {
    const rendered = await renderTaskDetailView({
      data: null,
      error: null,
      loading: false,
      updateTask: () => undefined,
    });
    const text = rendered.container.textContent ?? "";

    expect(text).toContain("タスクが見つかりません");
    expect(text).not.toContain("データ取得に失敗しました");
    expect(rendered.container.querySelector('[data-testid="human-decisions-panel"]')).toBeNull();
    expect(humanDecisionsPanelMock).not.toHaveBeenCalled();

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("旧responseにadditive lifecycleが無くても詳細画面を表示できる", async () => {
    const task = makeTask("legacy response");
    const legacy = {
      task,
      comments: [],
      events: [],
      runs: [],
      links: { parents: [], children: [] },
      dependencies: [],
      artifacts: [],
      artifactDetails: [],
      messages: {},
      orchestratorRequest: null,
      orchestratorBindings: [],
    } as unknown as NormalizedTaskDetailResponse;

    const rendered = await renderTaskDetailView({
      data: legacy,
      error: null,
      loading: false,
      updateTask: () => undefined,
    });

    expect(rendered.container.textContent).toContain("legacy response");
    expect(rendered.container.textContent).not.toContain("Durable cancel");
    expect(rendered.container.textContent).not.toContain("Durable steer");
    await act(async () => rendered.root.unmount());
  });

  it("ArtifactsCard を CommentsCard と同じ左カラムの最下段に描画する", async () => {
    const rendered = await renderTaskDetailView({
      data: {
        task: makeTask("artifact layout"),
        comments: [],
        events: [],
        runs: [],
        cancelRequests: [],
        steerDeliveries: [],
        links: { parents: [], children: [] },
        dependencies: [],
        artifacts: [],
        artifactDetails: [],
        messages: {},
        orchestratorRequest: null,
        orchestratorBindings: [],
      },
      error: null,
      loading: false,
      updateTask: () => undefined,
    });
    const headings = Array.from(rendered.container.querySelectorAll("h2"));
    const commentsCard = headings.find((heading) => heading.textContent === "コメント（0）")?.closest("section");
    const artifactsCard = headings.find((heading) => heading.textContent === "artifacts（0）")?.closest("section");

    expect(commentsCard).not.toBeNull();
    expect(artifactsCard).not.toBeNull();
    expect(artifactsCard?.parentElement).toBe(commentsCard?.parentElement);
    expect(artifactsCard?.parentElement?.lastElementChild).toBe(artifactsCard);

    await act(async () => rendered.root.unmount());
  });

  it("一致したtaskのHeader直後へprops由来のscopeで回答パネルを表示する", async () => {
    const task = makeTask("decision scope");
    const data = {
      task,
      comments: [],
      events: [],
      runs: [],
      cancelRequests: [],
      steerDeliveries: [],
      links: { parents: [], children: [] },
      dependencies: [],
      artifacts: [],
      artifactDetails: [],
      messages: {},
      orchestratorRequest: null,
      orchestratorBindings: [],
    } satisfies NormalizedTaskDetailResponse;
    const result: MockTaskDetailResult = {
      data,
      error: null,
      loading: false,
      updateTask: () => undefined,
    };
    const onOpenTask = vi.fn<(taskId: string) => void>();
    const rendered = await renderTaskDetailView(result, {
      taskId: task.id,
      tenant: "tenant-a",
      onOpenTask,
    });
    const panel = rendered.container.querySelector('[data-testid="human-decisions-panel"]');
    const header = Array.from(rendered.container.querySelectorAll("h1"))
      .find((heading) => heading.textContent === task.title)?.closest("section");

    expect(panel).not.toBeNull();
    expect(panel?.previousElementSibling).toBe(header);
    expect(humanDecisionsPanelMock).toHaveBeenLastCalledWith({
      taskId: task.id,
      tenant: "tenant-a",
      onOpenTask,
    });

    await rendered.rerender(result, {
      taskId: task.id,
      tenant: "tenant-b",
      onOpenTask,
    });
    expect(humanDecisionsPanelMock).toHaveBeenLastCalledWith({
      taskId: task.id,
      tenant: "tenant-b",
      onOpenTask,
    });

    await act(async () => rendered.root.unmount());
  });

  it("未取得または別taskの旧dataでは回答パネルを表示しない", async () => {
    const oldTask = makeTask("old task response");
    const oldData = {
      task: oldTask,
      comments: [],
      events: [],
      runs: [],
      cancelRequests: [],
      steerDeliveries: [],
      links: { parents: [], children: [] },
      dependencies: [],
      artifacts: [],
      artifactDetails: [],
      messages: {},
      orchestratorRequest: null,
      orchestratorBindings: [],
    } satisfies NormalizedTaskDetailResponse;
    const props: TaskDetailViewProps = {
      taskId: "t_0000000000000002",
      tenant: "tenant-new",
      onOpenTask: () => undefined,
    };
    const rendered = await renderTaskDetailView({
      data: oldData,
      error: null,
      loading: false,
      updateTask: () => undefined,
    }, props);

    expect(useTaskDetailMock).toHaveBeenLastCalledWith(props.taskId);
    expect(rendered.container.querySelector('[data-testid="human-decisions-panel"]')).toBeNull();
    expect(humanDecisionsPanelMock).not.toHaveBeenCalled();

    await rendered.rerender({
      data: { ...oldData, task: { ...oldTask, id: props.taskId } },
      error: "refresh failed",
      loading: false,
      updateTask: () => undefined,
    }, props);
    expect(rendered.container.textContent).toContain("データ取得に失敗しました: refresh failed");
    expect(rendered.container.querySelector('[data-testid="human-decisions-panel"]')).toBeNull();
    expect(humanDecisionsPanelMock).not.toHaveBeenCalled();

    await rendered.rerender({
      data: null,
      error: null,
      loading: true,
      updateTask: () => undefined,
    }, props);
    expect(rendered.container.textContent).toContain("読み込み中...");
    expect(rendered.container.querySelector('[data-testid="human-decisions-panel"]')).toBeNull();
    expect(humanDecisionsPanelMock).not.toHaveBeenCalled();

    await act(async () => rendered.root.unmount());
  });
});
