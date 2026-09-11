// @vitest-environment jsdom

import { act, type JSX, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRow } from "@hachi/core";
import type { Route } from "./hooks/use-navigation.js";
import type { DisplayBucket } from "./lib/constants.js";
import type { AppShellBoardControls } from "./components/AppShell.js";

interface HumanDecisionsDrawerSpyProps {
  taskId?: string;
  tenant?: string;
  onOpenTask: (taskId: string) => void;
}

interface TaskDetailViewSpyProps {
  taskId: string;
  tenant?: string;
  onOpenTask: (taskId: string) => void;
  onTaskUpdated?: (task: TaskRow) => void;
}

interface BoardViewSpyProps {
  bucket: DisplayBucket;
  watchedOnly: boolean;
  onOpenTask: (taskId: string) => void;
}

interface AppShellSpyProps {
  headerHumanDecisions?: ReactNode;
  boardControls: AppShellBoardControls;
  children: ReactNode;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
  route: { name: "board" } as Route,
  navigate: vi.fn<(path: string) => void>(),
  drawerProps: [] as HumanDecisionsDrawerSpyProps[],
  taskDetailProps: [] as TaskDetailViewSpyProps[],
  taskMounts: [] as string[],
  taskUnmounts: [] as string[],
  boardProps: [] as BoardViewSpyProps[],
  shellControls: null as AppShellBoardControls | null,
}));

const useBoardDataMock = vi.hoisted(() => vi.fn());
const setTaskWatchedMock = vi.hoisted(() => vi.fn());

vi.mock("./hooks/use-navigation.js", () => ({
  useNavigation: () => ({ route: testState.route, navigate: testState.navigate }),
}));

vi.mock("./hooks/use-board-data.js", () => ({
  useBoardData: useBoardDataMock,
}));

vi.mock("./hooks/use-debounced-value.js", () => ({
  useDebouncedValue: (value: string) => value,
}));

vi.mock("./lib/api.js", () => ({
  setTaskWatched: setTaskWatchedMock,
}));

vi.mock("motion/react", () => ({
  LazyMotion: (props: { children: ReactNode }): JSX.Element => <>{props.children}</>,
  MotionConfig: (props: { children: ReactNode }): JSX.Element => <>{props.children}</>,
  domMax: {},
}));

vi.mock("./components/AppShell.js", () => ({
  AppShell: (props: AppShellSpyProps): JSX.Element => {
    testState.shellControls = props.boardControls;
    return <div data-testid="app-shell"><header>{props.headerHumanDecisions}</header>{props.children}</div>;
  },
}));

vi.mock("./components/HumanDecisionsDrawer.js", () => ({
  HumanDecisionsDrawer: (props: HumanDecisionsDrawerSpyProps): JSX.Element => {
    testState.drawerProps.push(props);
    return <section data-testid="human-decisions-drawer" />;
  },
}));

vi.mock("./components/BoardView.js", () => ({
  BoardView: (props: BoardViewSpyProps): JSX.Element => {
    testState.boardProps.push(props);
    return <main data-testid="board-view" />;
  },
}));

vi.mock("./components/TaskDetailView.js", async () => {
  const { useEffect } = await import("react");
  return {
    TaskDetailView: (props: TaskDetailViewSpyProps): JSX.Element => {
      testState.taskDetailProps.push(props);
      useEffect(() => {
        testState.taskMounts.push(props.taskId);
        return () => {
          testState.taskUnmounts.push(props.taskId);
        };
      }, []);
      return <main data-testid="task-detail-view" data-task-id={props.taskId} />;
    },
  };
});

vi.mock("./components/KnowledgeView.js", () => ({
  KnowledgeView: (): JSX.Element => <main data-testid="knowledge-view" />,
}));

vi.mock("./components/SchedulesView.js", () => ({
  SchedulesView: (): JSX.Element => <main data-testid="schedules-view" />,
}));

vi.mock("./components/MetricsView.js", () => ({
  MetricsView: (): JSX.Element => <main data-testid="metrics-view" />,
}));

vi.mock("./components/UsageView.js", () => ({
  UsageView: (): JSX.Element => <main data-testid="usage-view" />,
}));

vi.mock("./components/SessionsPanel.js", () => ({
  SessionsView: (): JSX.Element => <main data-testid="sessions-view" />,
  SessionPageView: (): JSX.Element => <main data-testid="session-view" />,
}));

vi.mock("./components/SettingsView.js", () => ({
  SettingsView: (): JSX.Element => <main data-testid="settings-view" />,
}));

vi.mock("./components/WriteTokenModal.js", () => ({
  WriteTokenModal: (): JSX.Element => <div data-testid="write-token-modal" />,
}));

import { App } from "./App.js";

interface RenderedApp {
  container: HTMLDivElement;
  root: Root;
  rerender: () => Promise<void>;
}

const mountedRoots = new Set<Root>();
const updateTaskMock = vi.fn<(task: TaskRow) => void>();

function latest<T>(values: T[]): T {
  const value = values.at(-1);
  if (value === undefined) {
    throw new Error("spy resultがありません");
  }
  return value;
}

function currentControls(): AppShellBoardControls {
  if (testState.shellControls === null) {
    throw new Error("AppShell controlsがありません");
  }
  return testState.shellControls;
}

async function renderApp(): Promise<RenderedApp> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  const rerender = async (): Promise<void> => {
    await act(async () => {
      root.render(<App />);
      await Promise.resolve();
    });
  };
  await rerender();
  return { container, root, rerender };
}

async function unmount(root: Root): Promise<void> {
  if (!mountedRoots.delete(root)) return;
  await act(async () => root.unmount());
}

beforeEach(() => {
  testState.route = { name: "board" };
  testState.navigate.mockReset();
  testState.drawerProps.length = 0;
  testState.taskDetailProps.length = 0;
  testState.taskMounts.length = 0;
  testState.taskUnmounts.length = 0;
  testState.boardProps.length = 0;
  testState.shellControls = null;
  updateTaskMock.mockReset();
  useBoardDataMock.mockReset();
  useBoardDataMock.mockReturnValue({
    data: null,
    error: null,
    loading: false,
    updateTask: updateTaskMock,
  });
  setTaskWatchedMock.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => {
    throw new Error("App接続テストではnetworkを使用しません");
  }));
});

afterEach(async () => {
  for (const root of [...mountedRoots]) {
    await unmount(root);
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("App human decision integration", () => {
  it("boardだけでヘッダーへDrawerを渡し、tenantだけをscopeへ渡す", async () => {
    const rendered = await renderApp();
    const drawer = rendered.container.querySelector('[data-testid="human-decisions-drawer"]');
    const board = rendered.container.querySelector('[data-testid="board-view"]');
    const initialDrawerProps = latest(testState.drawerProps);

    expect(drawer).not.toBeNull();
    expect(drawer?.parentElement?.tagName).toBe("HEADER");
    expect(drawer?.parentElement?.nextElementSibling).toBe(board);
    expect(Object.keys(initialDrawerProps).sort()).toEqual(["onOpenTask", "tenant"]);
    expect(initialDrawerProps.tenant).toBe("");

    await act(async () => {
      currentControls().onTenantChange("tenant-a");
      await Promise.resolve();
    });
    expect(latest(testState.drawerProps).tenant).toBe("tenant-a");

    await act(async () => {
      const controls = currentControls();
      controls.onQueryChange("needle");
      controls.onBucketChange("review");
      controls.onWatchedOnlyChange(true);
      await Promise.resolve();
    });
    const filteredDrawerProps = latest(testState.drawerProps);
    expect(Object.keys(filteredDrawerProps).sort()).toEqual(["onOpenTask", "tenant"]);
    expect(filteredDrawerProps.tenant).toBe("tenant-a");
    expect(useBoardDataMock).toHaveBeenLastCalledWith("tenant-a", "needle");
    expect(latest(testState.boardProps)).toMatchObject({
      bucket: "review",
      watchedOnly: true,
    });

    act(() => filteredDrawerProps.onOpenTask("task/id with space"));
    expect(testState.navigate).toHaveBeenLastCalledWith("/task/task%2Fid%20with%20space");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("task routeへtaskIdとtenantを渡し、task切替時にkeyで再mountする", async () => {
    testState.route = { name: "task", taskId: "task-a" };
    const rendered = await renderApp();

    expect(rendered.container.querySelector('[data-testid="human-decisions-drawer"]')).toBeNull();
    expect(latest(testState.taskDetailProps)).toMatchObject({
      taskId: "task-a",
      tenant: "",
      onOpenTask: expect.any(Function),
    });
    expect(testState.taskMounts).toEqual(["task-a"]);
    expect(testState.taskUnmounts).toEqual([]);

    await act(async () => {
      currentControls().onTenantChange("tenant-detail");
      await Promise.resolve();
    });
    expect(latest(testState.taskDetailProps).tenant).toBe("tenant-detail");
    expect(testState.taskMounts).toEqual(["task-a"]);

    testState.route = { name: "task", taskId: "task-b" };
    await rendered.rerender();
    expect(latest(testState.taskDetailProps)).toMatchObject({
      taskId: "task-b",
      tenant: "tenant-detail",
      onOpenTask: expect.any(Function),
    });
    expect(testState.taskMounts).toEqual(["task-a", "task-b"]);
    expect(testState.taskUnmounts).toEqual(["task-a"]);

    act(() => latest(testState.taskDetailProps).onOpenTask("child/id with space"));
    expect(testState.navigate).toHaveBeenLastCalledWith("/task/child%2Fid%20with%20space");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("board/task以外ではPanelを表示せずWriteTokenModalを一つだけ維持する", async () => {
    const otherRoutes: Route[] = [
      { name: "schedules" },
      { name: "knowledge" },
      { name: "sessions" },
      { name: "session", sessionId: "session-a" },
      { name: "metrics" },
      { name: "usage" },
      { name: "settings" },
    ];
    testState.route = otherRoutes[0] ?? { name: "schedules" };
    const rendered = await renderApp();

    for (const route of otherRoutes) {
      testState.route = route;
      await rendered.rerender();
      expect(rendered.container.querySelectorAll('[data-testid="human-decisions-drawer"]')).toHaveLength(0);
      expect(rendered.container.querySelectorAll('[data-testid="task-detail-view"]')).toHaveLength(0);
      expect(rendered.container.querySelectorAll('[data-testid="write-token-modal"]')).toHaveLength(1);
    }
    expect(testState.drawerProps).toHaveLength(0);
    expect(testState.taskDetailProps).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
