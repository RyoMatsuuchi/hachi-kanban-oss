// =============================================================================
// アプリケーションルート。/・/task/:id・/schedules・/sessions・/session/:id を history API ベースで切替える
// （docs/contract.md §20.1: 外部 router 依存を増やさない）。
// =============================================================================

import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";
import type { TaskRow } from "@hachi/core";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { useNavigation } from "./hooks/use-navigation.js";
import { useBoardData } from "./hooks/use-board-data.js";
import { useDebouncedValue } from "./hooks/use-debounced-value.js";
import { setTaskWatched } from "./lib/api.js";
import type { DisplayBucket } from "./lib/constants.js";
import { AppShell } from "./components/AppShell.js";
import { BoardView } from "./components/BoardView.js";
import { HumanDecisionsDrawer } from "./components/HumanDecisionsDrawer.js";
import { KnowledgeView } from "./components/KnowledgeView.js";
import { SchedulesView } from "./components/SchedulesView.js";
import { TaskDetailView } from "./components/TaskDetailView.js";
import { MetricsView } from "./components/MetricsView.js";
import { UsageView } from "./components/UsageView.js";
import { SessionPageView, SessionsView } from "./components/SessionsPanel.js";
import { SettingsView } from "./components/SettingsView.js";
import type { SupervisorCounts } from "./components/SupervisorPanel.js";
import { WriteTokenModal } from "./components/WriteTokenModal.js";

export function App(): JSX.Element {
  const { route, navigate } = useNavigation();
  const [tenant, setTenant] = useState<string>("");
  const [bucket, setBucket] = useState<DisplayBucket>("all");
  const [watchedOnly, setWatchedOnly] = useState<boolean>(false);
  const [queryInput, setQueryInput] = useState<string>("");
  const query = useDebouncedValue(queryInput, 300);
  const board = useBoardData(tenant, query);
  const openTask = useCallback((taskId: string): void => {
    navigate(`/task/${encodeURIComponent(taskId)}`);
  }, [navigate]);
  const openSession = useCallback((sessionId: string): void => {
    navigate(`/session/${encodeURIComponent(sessionId)}`);
  }, [navigate]);
  const toggleTaskWatch = useCallback(
    (task: TaskRow): void => {
      void setTaskWatched(task.id, !task.watched).then((updated) => {
        board.updateTask(updated);
      });
    },
    [board.updateTask],
  );
  const boardCounts = useMemo<SupervisorCounts | null>(() => {
    if (board.data === null) {
      return null;
    }
    return {
      counts: board.data.counts,
      retryPending: board.data.retryPending,
    };
  }, [board.data]);
  let content: JSX.Element;

  if (route.name === "task") {
    content = (
      <TaskDetailView
        key={route.taskId}
        taskId={route.taskId}
        tenant={tenant}
        onOpenTask={openTask}
        onTaskUpdated={board.updateTask}
      />
    );
  } else if (route.name === "schedules") {
    content = <SchedulesView />;
  } else if (route.name === "knowledge") {
    content = <KnowledgeView />;
  } else if (route.name === "sessions") {
    content = (
      <SessionsView
        onOpenSession={openSession}
      />
    );
  } else if (route.name === "session") {
    content = <SessionPageView sessionId={route.sessionId} />;
  } else if (route.name === "metrics") {
    content = <MetricsView />;
  } else if (route.name === "usage") {
    content = <UsageView />;
  } else if (route.name === "settings") {
    content = <SettingsView />;
  } else {
    content = (
      <>
        <BoardView
          data={board.data}
          error={board.error}
          loading={board.loading}
          bucket={bucket}
          onOpenTask={openTask}
          watchedOnly={watchedOnly}
          onToggleWatch={toggleTaskWatch}
        />
      </>
    );
  }

  return (
    <>
      <WriteTokenModal />
      <LazyMotion features={domMax} strict>
        <MotionConfig reducedMotion="user">
          <AppShell
            headerHumanDecisions={route.name === "board"
              ? <HumanDecisionsDrawer key={tenant} tenant={tenant} onOpenTask={openTask} />
              : undefined}
            route={route}
            boardCounts={boardCounts}
            boardControls={{
              tenants: board.data?.tenants ?? [],
              tenant,
              bucket,
              watchedOnly,
              query: queryInput,
              onTenantChange: setTenant,
              onBucketChange: setBucket,
              onWatchedOnlyChange: setWatchedOnly,
              onQueryChange: setQueryInput,
            }}
            onNavigate={navigate}
          >
            {content}
          </AppShell>
        </MotionConfig>
      </LazyMotion>
    </>
  );
}
