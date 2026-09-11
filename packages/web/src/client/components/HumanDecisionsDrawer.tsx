import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type JSX } from "react";
import type { HumanDecisionRequestRow } from "@hachi/core";
import { useHumanDecisions, type HumanDecisionSubmissionState } from "../hooks/use-human-decisions.js";
import { HumanDecisionCard, type HumanDecisionDraft } from "./HumanDecisionCard.js";

export interface HumanDecisionsDrawerProps {
  tenant?: string;
  onOpenTask: (taskId: string) => void;
}

type DecisionTab = "waiting" | "answered" | "history";
const TABS: { value: DecisionTab; label: string }[] = [
  { value: "waiting", label: "確認待ち" },
  { value: "answered", label: "回答済み" },
  { value: "history", label: "履歴" },
];
const UNAVAILABLE: HumanDecisionSubmissionState = {
  phase: "idle", error: null, canSubmit: false, canRetry: false, pendingAnswer: null,
};
const BUTTON = "min-h-9 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function requestTab(request: HumanDecisionRequestRow): DecisionTab {
  if (request.status === "waiting_human") return "waiting";
  if (request.status === "answered" || request.status === "claimed") return "answered";
  return "history";
}

function ScopedHumanDecisionsDrawer(props: HumanDecisionsDrawerProps): JSX.Element {
  const decisions = useHumanDecisions(props.tenant === undefined ? {} : { tenant: props.tenant });
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<DecisionTab>("waiting");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState<Record<string, HumanDecisionDraft>>({});
  const confirmedRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const count = decisions.requests?.filter((request) => request.status === "waiting_human").length;
  const countLabel = count === undefined
    ? (decisions.error === null ? "件数を読み込み中" : "件数を取得できません")
    : `${count}件${decisions.stale ? "、更新失敗・前回の件数" : ""}`;

  useEffect(() => {
    // GETのrevision更新は他者の回答かもしれないため、自分のPOST成功だけを通知する。
    if (decisions.confirmedAnswerCount === confirmedRef.current) return;
    confirmedRef.current = decisions.confirmedAnswerCount;
    setNotice("回答しました。回答済みで確認できます");
    if (open && document.querySelector('[data-write-token-dialog]') === null) {
      setTab("waiting");
      headingRef.current?.focus();
    }
  }, [decisions.confirmedAnswerCount, open]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => {
      if (next) setTab("waiting");
      setOpen(next);
    }}>
      <Dialog.Trigger className={`${BUTTON} inline-flex shrink-0 items-center gap-1.5`} aria-label={`人間への確認、${countLabel}`}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M9 18h6m-5 3h4M8 14a7 7 0 1 1 8 0l-1 2H9z" /></svg>
        <span className="hidden md:inline">人間への確認</span>
        {count === undefined ? <span aria-hidden="true">{decisions.error === null ? "…" : "!"}</span> : count > 0 ? <span aria-hidden="true" className="rounded-full bg-danger-soft px-1.5 text-xs font-semibold text-danger-strong">{count}</span> : null}
        {decisions.stale ? <span aria-hidden="true" className="text-warn-strong">!</span> : null}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay backdrop-blur-sm" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-full flex-col border-l border-line bg-surface text-ink shadow-xl md:w-[560px]"
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => { event.preventDefault(); headingRef.current?.focus(); }}
        >
          <div className="space-y-3 border-b border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <Dialog.Title className="text-lg font-semibold">人間への確認</Dialog.Title>
              <Dialog.Close className={BUTTON} aria-label="確認を閉じる">閉じる</Dialog.Close>
            </div>
            <Dialog.Description className="text-xs text-ink-muted">対象: {props.tenant || "全テナント"}。検索・状態・watchの絞り込みは適用されません。</Dialog.Description>
            <div className="flex gap-1" aria-label="確認の分類">
              {TABS.map((item) => <button key={item.value} type="button" aria-pressed={tab === item.value} className={`${BUTTON} flex-1 px-2 aria-pressed:bg-accent-soft aria-pressed:font-semibold`} onClick={() => setTab(item.value)}>{item.label}</button>)}
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
            <p role="status" className="text-sm text-ink-muted">{notice}</p>
            <h2 ref={headingRef} tabIndex={-1} className="font-semibold outline-none">{TABS.find((item) => item.value === tab)?.label}</h2>
            {decisions.requests === null && decisions.error === null ? <p role="status">確認依頼を読み込み中</p> : null}
            {decisions.error !== null ? <div role="alert" className="space-y-2 rounded-md bg-warn-soft p-2 text-sm text-warn-strong">
              <p>{decisions.stale ? "更新に失敗しました。前回の内容を表示しています" : "確認依頼の取得に失敗しました"}</p>
              <p className="whitespace-pre-wrap break-words">{decisions.error}</p>
              <button type="button" className={BUTTON} onClick={() => { void decisions.refresh().catch(() => undefined); }}>再取得</button>
            </div> : null}
            {decisions.requests !== null && !decisions.requests.some((request) => requestTab(request) === tab)
              ? <p className="text-sm text-ink-muted">{tab === "waiting" ? "確認待ちはありません" : tab === "answered" ? "回答済みの確認はありません" : "履歴はありません"}</p> : null}
            {decisions.requests?.map((request) => <div key={request.id} hidden={requestTab(request) !== tab}>
              <HumanDecisionCard statusLabel={request.status === "answered" ? "処理待ち" : request.status === "claimed" ? "処理中" : undefined} request={request} submission={decisions.submissions[request.id] ?? UNAVAILABLE}
                draft={drafts[request.id] ?? { choiceId: "", text: "", comment: "" }}
                onDraftChange={(draft) => setDrafts((current) => ({ ...current, [request.id]: draft }))}
                onSubmit={decisions.submit}
                onRetry={decisions.retrySameAnswer}
                onOpenTask={props.onOpenTask} />
            </div>)}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function HumanDecisionsDrawer(props: HumanDecisionsDrawerProps): JSX.Element {
  return <ScopedHumanDecisionsDrawer key={props.tenant ?? ""} {...props} />;
}
