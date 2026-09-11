// =============================================================================
// ボードのレーン1つ分。横一列に並ぶ状態レーン/自律進行中レーン/要対応（人間確認キュー）レーン共通の
// カラムレイアウト: 固定幅・カラム内縦スクロール・sticky ヘッダー（レーン名+件数チップ）。
// 要対応レーンは tone="danger" を指定して赤系アクセントで目立たせる。
// =============================================================================

import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import type { SteerDeliveryReadModel, TaskRow } from "@hachi/core";
import { TaskCard, type CardVariant } from "./TaskCard.js";
import { ScrollArea } from "./ui/ScrollArea.js";

export type LaneTone = "danger" | "info" | "neutral";

export interface LaneProps {
  title: string;
  description?: string;
  tasks: TaskRow[];
  variant: CardVariant;
  tone?: LaneTone;
  onOpenTask: (taskId: string) => void;
  onToggleWatch?: (task: TaskRow) => void;
  steerDeliveriesByTask?: Record<string, SteerDeliveryReadModel[]>;
}

const TONE_CLASSES: Record<LaneTone, string> = {
  danger: "border-line border-l-2 border-l-danger-strong/50 bg-surface",
  info: "border-accent/30 bg-accent-soft",
  neutral: "border-line bg-surface",
};

/** sticky ヘッダー用（下にスクロールしたカードが透けないよう不透明寄りにする） */
const TONE_HEADER_CLASSES: Record<LaneTone, string> = {
  danger: "border-line bg-danger-soft",
  info: "border-accent/30 bg-accent-soft",
  neutral: "border-line bg-surface/95",
};

function LaneHeader(props: { title: string; description: string | undefined; count: number; className: string }): JSX.Element {
  return (
    <header className={props.className}>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="min-w-0 text-sm font-semibold text-ink">{props.title}</h2>
        <span className="inline-flex min-w-5 shrink-0 justify-center rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium tabular-nums text-ink-muted">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={props.count}
              className="inline-block tabular-nums"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.12 }}
            >
              {props.count}
            </m.span>
          </AnimatePresence>
        </span>
      </div>
      {props.description !== undefined ? (
        <p className="mt-1 text-xs leading-4 text-ink-muted">{props.description}</p>
      ) : null}
    </header>
  );
}

export function Lane(props: LaneProps): JSX.Element {
  const { title, description, tasks, variant, onOpenTask, onToggleWatch, steerDeliveriesByTask } = props;
  const tone = props.tone ?? "neutral";
  const isEmpty = tasks.length === 0;
  const previousTaskCountRef = useRef<number>(tasks.length);
  const [isExitSpaceReserved, setIsExitSpaceReserved] = useState<boolean>(false);
  const hadTasksOnPreviousRender = previousTaskCountRef.current > 0;
  const shouldShowTaskArea = !isEmpty || isExitSpaceReserved || hadTasksOnPreviousRender;

  useEffect((): void => {
    if (!isEmpty) {
      setIsExitSpaceReserved(false);
    } else if (hadTasksOnPreviousRender) {
      setIsExitSpaceReserved(true);
    }
    previousTaskCountRef.current = tasks.length;
  }, [hadTasksOnPreviousRender, isEmpty, tasks.length]);

  const handleExitComplete = useCallback((): void => {
    if (tasks.length === 0) {
      setIsExitSpaceReserved(false);
    }
  }, [tasks.length]);
  const watchProps = onToggleWatch === undefined ? {} : { onToggleWatch };

  return (
    <section
      className={`flex max-h-[calc(100vh-4rem)] w-[min(85vw,20rem)] shrink-0 snap-start flex-col overflow-hidden rounded-md border sm:w-72 ${TONE_CLASSES[tone]}`}
    >
      <LaneHeader
        title={title}
        description={description}
        count={tasks.length}
        className={`sticky top-0 z-10 px-3 py-2 backdrop-blur ${shouldShowTaskArea ? "rounded-t-md border-b" : "rounded-md"} ${TONE_HEADER_CLASSES[tone]}`}
      />
      <ScrollArea
        fitWidth
        className={`min-h-0 ${shouldShowTaskArea ? "flex-1" : "h-0 flex-none"}`}
        viewportClassName="min-h-0"
      >
        <div className={`min-w-0 ${shouldShowTaskArea ? "p-2" : "p-0"}`}>
          <ul className="flex min-w-0 flex-col gap-2">
            <AnimatePresence initial={false} mode="popLayout" onExitComplete={handleExitComplete}>
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  variant={variant}
                  onOpen={onOpenTask}
                  steerDeliveries={steerDeliveriesByTask?.[task.id] ?? []}
                  {...watchProps}
                />
              ))}
            </AnimatePresence>
          </ul>
        </div>
      </ScrollArea>
    </section>
  );
}
