// =============================================================================
// ボード画面（/）。AppShell 直下にレーン列（横一列、判断待ち→回収待ち→triage→todo→ready→
// 自律進行中→review→needs-integration→done）の順に表示する。判断待ちは従来の赤系アクセントで
// レーン列の左端に配置する
// （docs/contract.md §14.3 のレーン順序を踏襲、§20 で React SPA 化）。
// =============================================================================

import type { JSX } from "react";
import type { TaskRow } from "@hachi/core";
import type { BoardResponse } from "../../shared/api-types.js";
import { Lane } from "./Lane.js";
import { ScrollArea } from "./ui/ScrollArea.js";
import { STATE_LANE_LABELS, STATE_LANE_ORDER, type DisplayBucket } from "../lib/constants.js";

export interface BoardViewProps {
  data: BoardResponse | null;
  error: string | null;
  loading: boolean;
  bucket: DisplayBucket;
  onOpenTask: (taskId: string) => void;
  watchedOnly: boolean;
  onToggleWatch: (task: TaskRow) => void;
}

function ErrorBanner(props: { message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
      データ取得に失敗しました: {props.message}
    </div>
  );
}

// レーンの左→右並び順は triage → todo → ready → 自律進行中 → review → needs-integration → done
// （状態が進行する向きに揃える）。STATE_LANE_ORDER は状態レーンのみを持つため、
// "review" の手前で自律進行中レーンを差し込む形に分割する。
const REVIEW_INDEX = STATE_LANE_ORDER.indexOf("review");
const LANES_BEFORE_IN_PROGRESS = STATE_LANE_ORDER.slice(0, REVIEW_INDEX);
const LANES_FROM_REVIEW = STATE_LANE_ORDER.slice(REVIEW_INDEX);

export function BoardView(props: BoardViewProps): JSX.Element {
  const { data, error, loading, bucket, onOpenTask, watchedOnly, onToggleWatch } = props;

  const showHumanQueue = bucket === "all" || bucket === "human_queue";
  const showInProgress = bucket === "all" || bucket === "in_progress";
  const filterWatched = (tasks: TaskRow[]): TaskRow[] => (watchedOnly ? tasks.filter((task) => task.watched) : tasks);

  return (
    <main className="w-full px-2 py-2 sm:px-4">
      {error !== null ? (
        <div className="mb-2">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      {data === null && loading ? (
        <p className="py-16 text-center text-sm text-ink-muted">読み込み中...</p>
      ) : data !== null ? (
        // 人間確認キューの2分類を左端に、状態が進行する向き（左→右）にレーンを横一列で並べる。
        // 折り返さずレーン行内のみ横スクロール
        <ScrollArea
          className="w-full"
          scrollbars="horizontal"
          viewportClassName="snap-x snap-mandatory scroll-px-2 sm:scroll-px-4"
        >
          <div className="flex w-max min-w-full flex-nowrap items-start gap-3 pb-3">
            {showHumanQueue ? (
              <>
                <Lane
                  title="あなたの判断待ち"
                  description="あなたの回答・承認が必要です。"
                  tasks={filterWatched(data.lanes.humanDecisionQueue)}
                  variant="human-queue"
                  tone="danger"
                  onOpenTask={onOpenTask}
                  onToggleWatch={onToggleWatch}
                  steerDeliveriesByTask={data.steerDeliveriesByTask}
                />
                <Lane
                  title="オーケストレーター回収待ち"
                  description="自動処理の担当が回収します。通常は対応不要"
                  tasks={filterWatched(data.lanes.orchestratorRecoveryQueue)}
                  variant="human-queue"
                  tone="neutral"
                  onOpenTask={onOpenTask}
                  onToggleWatch={onToggleWatch}
                  steerDeliveriesByTask={data.steerDeliveriesByTask}
                />
              </>
            ) : null}
            {LANES_BEFORE_IN_PROGRESS.filter((key) => bucket === "all" || bucket === key).map((key) => (
              <Lane
                key={key}
                title={STATE_LANE_LABELS[key]}
                tasks={filterWatched(data.lanes.byStatus[key])}
                variant="plain"
                onOpenTask={onOpenTask}
                onToggleWatch={onToggleWatch}
                steerDeliveriesByTask={data.steerDeliveriesByTask}
              />
            ))}
            {showInProgress ? (
              <Lane
                title="自律進行中"
                tasks={filterWatched(data.lanes.inProgress)}
                variant="in-progress"
                tone="info"
                onOpenTask={onOpenTask}
                onToggleWatch={onToggleWatch}
                steerDeliveriesByTask={data.steerDeliveriesByTask}
              />
            ) : null}
            {LANES_FROM_REVIEW.filter((key) => bucket === "all" || bucket === key).map((key) => (
              <Lane
                key={key}
                title={STATE_LANE_LABELS[key]}
                tasks={filterWatched(data.lanes.byStatus[key])}
                variant="plain"
                onOpenTask={onOpenTask}
                onToggleWatch={onToggleWatch}
                steerDeliveriesByTask={data.steerDeliveriesByTask}
              />
            ))}
          </div>
        </ScrollArea>
      ) : null}
    </main>
  );
}
