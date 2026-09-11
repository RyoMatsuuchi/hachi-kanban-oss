// =============================================================================
// タスク詳細画面（/task/:id）。task 全項目・コメント時系列・イベント監査履歴・実行履歴・
// 親子リンク・artifacts を表示する（docs/contract.md §14.3・§20.2）。
// カード単位でセクションを区切り、ボード画面と同様にビューポート幅いっぱいに表示する。
// =============================================================================

import type { JSX } from "react";
import type { TaskRow } from "@hachi/core";
import { useCallback } from "react";
import { useTaskDetail } from "../hooks/use-task-detail.js";
import { setTaskWatched } from "../lib/api.js";
import { TaskHeaderCard } from "./TaskHeaderCard.js";
import { HumanDecisionsPanel } from "./HumanDecisionsPanel.js";
import { TaskFieldsCard } from "./TaskFieldsCard.js";
import { BodyCard } from "./BodyCard.js";
import { CommentsCard } from "./CommentsCard.js";
import { EventsCard } from "./EventsCard.js";
import { RunsCard } from "./RunsCard.js";
import { ModelTransportCard } from "./ModelTransportCard.js";
import { LinksCard } from "./LinksCard.js";
import { ArtifactsCard } from "./ArtifactsCard.js";
import { OrchestratorRoutingCard } from "./OrchestratorRoutingCard.js";
import { CancelLifecycleCard } from "./CancelLifecycleCard.js";
import { SteerLifecycleCard } from "./SteerLifecycleCard.js";

export interface TaskDetailViewProps {
  taskId: string;
  tenant?: string;
  onOpenTask: (taskId: string) => void;
  onTaskUpdated?: (task: TaskRow) => void;
}

function ErrorBanner(props: { message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
      データ取得に失敗しました: {props.message}
    </div>
  );
}

export function TaskDetailView(props: TaskDetailViewProps): JSX.Element {
  const { taskId, tenant, onOpenTask, onTaskUpdated } = props;
  const { data, error, loading, updateTask } = useTaskDetail(taskId);
  const shouldShowNotFound = data === null && !loading && error === null;
  const handleToggleWatch = useCallback(
    (task: TaskRow): void => {
      void setTaskWatched(task.id, !task.watched).then((updated) => {
        updateTask(updated);
        onTaskUpdated?.(updated);
      });
    },
    [onTaskUpdated, updateTask],
  );

  return (
    <main className="w-full space-y-3 px-2 py-2 sm:px-4">
      {error !== null ? <ErrorBanner message={error} /> : null}

      {data === null && loading ? (
        <p className="py-16 text-center text-sm text-ink-muted">読み込み中...</p>
      ) : data !== null ? (
        <>
          <TaskHeaderCard task={data.task} onToggleWatch={handleToggleWatch} />
          {data.task.id === taskId && error === null && !loading ? (
            <HumanDecisionsPanel
              taskId={taskId}
              {...(tenant === undefined ? {} : { tenant })}
              onOpenTask={onOpenTask}
            />
          ) : null}
          {/* lg 以上では本文/コメント（左・主カラム）とメタデータ（右・サイドカラム）を横並び、
              小画面では縦積み。min-w-0 で左カラム内のコードブロック等の横溢れを防ぐ。 */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
            <div className="min-w-0 flex-1 space-y-3">
              <BodyCard body={data.task.body} />
              {/* 実行履歴は列が多く幅を要するため、狭いサイドカラムではなく主カラムに置く */}
              <RunsCard runs={data.runs} />
              <CancelLifecycleCard requests={data.cancelRequests ?? []} />
              <SteerLifecycleCard deliveries={data.steerDeliveries ?? []} />
              <CommentsCard comments={data.comments} messages={data.messages} runs={data.runs} />
              <ArtifactsCard
                taskId={data.task.id}
                artifactDetails={data.artifactDetails}
                runs={data.runs}
              />
            </div>
            <div className="min-w-0 space-y-3 lg:w-[420px] lg:shrink-0 xl:w-[440px]">
              <TaskFieldsCard task={data.task} />
              <ModelTransportCard events={data.events} />
              <OrchestratorRoutingCard
                request={data.orchestratorRequest}
                bindings={data.orchestratorBindings}
              />
              <EventsCard events={data.events} />
              <LinksCard links={data.links} dependencies={data.dependencies} onOpenTask={onOpenTask} />
            </div>
          </div>
        </>
      ) : shouldShowNotFound ? (
        <p className="py-16 text-center text-sm text-ink-muted">タスクが見つかりません</p>
      ) : null}
    </main>
  );
}
