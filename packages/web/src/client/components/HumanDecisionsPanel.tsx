import type { JSX } from "react";
import {
  useHumanDecisions,
  type HumanDecisionScope,
  type HumanDecisionSubmissionState,
} from "../hooks/use-human-decisions.js";
import { Card } from "./Card.js";
import { HumanDecisionCard } from "./HumanDecisionCard.js";

const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50";

const UNAVAILABLE_SUBMISSION: HumanDecisionSubmissionState = {
  phase: "idle",
  error: null,
  canSubmit: false,
  canRetry: false,
  pendingAnswer: null,
};

export interface HumanDecisionsPanelProps {
  taskId?: string;
  tenant?: string;
  onOpenTask: (taskId: string) => void;
}

function refreshWithoutUnhandledRejection(refresh: () => Promise<void>): void {
  void refresh().catch(() => undefined);
}

function ScopedHumanDecisionsPanel(props: HumanDecisionsPanelProps): JSX.Element {
  const scope: HumanDecisionScope = props.taskId === undefined
    ? (props.tenant === undefined ? {} : { tenant: props.tenant })
    : (props.tenant === undefined
      ? { taskId: props.taskId }
      : { taskId: props.taskId, tenant: props.tenant });
  const decisions = useHumanDecisions(scope);
  const initialFailure = decisions.requests === null && decisions.error !== null;
  const initialLoading = decisions.requests === null && decisions.error === null;

  return (
    <Card title="人間への確認" className="min-w-0 space-y-3">
      <p className="text-xs text-ink-muted">
        {props.taskId === undefined
          ? "この一覧にはテナントの絞り込みだけが適用されます"
          : "このタスクへの確認"}
      </p>
      {initialLoading ? (
        <p role="status" className="text-sm text-ink-muted">確認依頼を読み込み中</p>
      ) : null}
      {initialFailure ? (
        <div role="alert" className="space-y-2 rounded-md bg-danger-soft p-2 text-sm text-danger-strong">
          <p className="whitespace-pre-wrap break-words">確認依頼の取得に失敗しました: {decisions.error}</p>
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={() => refreshWithoutUnhandledRejection(decisions.refresh)}
          >
            再取得
          </button>
        </div>
      ) : null}
      {decisions.requests !== null && decisions.stale ? (
        <div role="alert" className="space-y-2 rounded-md bg-warn-soft p-2 text-sm text-warn-strong">
          <p>更新に失敗しました。前回の内容を表示しています</p>
          {decisions.error === null ? null : (
            <p className="whitespace-pre-wrap break-words">{decisions.error}</p>
          )}
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            onClick={() => refreshWithoutUnhandledRejection(decisions.refresh)}
          >
            再取得
          </button>
        </div>
      ) : null}
      {decisions.requests !== null && decisions.requests.length === 0 ? (
        <p className="text-sm italic text-ink-muted">確認依頼はありません</p>
      ) : null}
      {decisions.requests !== null && decisions.requests.length > 0 ? (
        <div className="space-y-3">
          {decisions.requests.map((request) => (
            <HumanDecisionCard
              key={request.id}
              request={request}
              submission={decisions.submissions[request.id] ?? UNAVAILABLE_SUBMISSION}
              onSubmit={decisions.submit}
              onRetry={decisions.retrySameAnswer}
              onOpenTask={props.onOpenTask}
            />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export function HumanDecisionsPanel(props: HumanDecisionsPanelProps): JSX.Element {
  const scopeKey = JSON.stringify([props.taskId ?? null, props.tenant ?? ""]);
  return <ScopedHumanDecisionsPanel key={scopeKey} {...props} />;
}
