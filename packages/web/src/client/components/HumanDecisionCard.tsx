import { useEffect, useRef, useState, type JSX } from "react";
import type { HumanDecisionAnswer, HumanDecisionLink, HumanDecisionRequestRow } from "@hachi/core";
import type { HumanDecisionSubmissionState } from "../hooks/use-human-decisions.js";
import { formatTimestamp } from "../lib/format.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { Card } from "./Card.js";

const FIELD_CLASS =
  "w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";
const LABEL_CLASS = "grid min-w-0 gap-1 text-xs font-semibold text-ink-muted";
const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md bg-accent-strong px-3 py-1.5 text-sm font-semibold text-on-accent transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-danger-strong/30 bg-surface px-3 py-1.5 text-xs font-medium text-danger-strong transition hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50";

const KIND_LABELS: Record<HumanDecisionRequestRow["kind"], string> = {
  approval: "承認",
  decision: "判断",
  review: "レビュー",
};

const STATUS_LABELS: Record<HumanDecisionRequestRow["status"], string> = {
  waiting_human: "回答待ち",
  answered: "回答済み・受領待ち",
  claimed: "受領済み・未解決",
  resolved: "解決済み",
  cancelled: "取消済み",
};

const DEFAULT_OUTCOME_LABELS: Record<HumanDecisionRequestRow["defaultOutcome"], string> = {
  deny: "拒否",
  retain_current_state: "現状維持",
  not_accepted: "不採択",
};

export interface HumanDecisionDraft {
  choiceId: string;
  text: string;
  comment: string;
}

export interface HumanDecisionCardProps {
  statusLabel?: string | undefined;
  draft?: HumanDecisionDraft;
  onDraftChange?: (draft: HumanDecisionDraft) => void;
  request: HumanDecisionRequestRow;
  submission: HumanDecisionSubmissionState;
  onSubmit: (
    requestId: string,
    answer: HumanDecisionAnswer,
    comment?: string | null,
  ) => Promise<void>;
  onRetry: (requestId: string) => Promise<void>;
  onOpenTask: (taskId: string) => void;
}

function statusTone(status: HumanDecisionRequestRow["status"]): BadgeTone {
  if (status === "waiting_human") return "danger";
  if (status === "answered") return "info";
  if (status === "claimed") return "warning";
  if (status === "resolved") return "success";
  return "neutral";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function answerLabel(request: HumanDecisionRequestRow, answer: HumanDecisionAnswer): string {
  if (answer.kind === "approval") {
    return answer.outcome === "approve" ? "承認する" : "却下する";
  }
  if (answer.kind === "review") {
    return answer.outcome === "accepted" ? "受け入れる" : "修正を依頼する";
  }
  if ("choiceId" in answer) {
    const choice = request.choices.find((item) => item.id === answer.choiceId);
    return choice === undefined
      ? `選択: ${answer.choiceId}`
      : `選択: ${choice.label}（${answer.choiceId}）`;
  }
  return `自由回答: ${answer.text}`;
}

function resolutionLabel(request: HumanDecisionRequestRow): string | null {
  const resolution = request.resolution;
  if (resolution === null) return null;
  if (resolution.outcome === "handled") {
    return resolution.note === undefined || resolution.note === null || resolution.note === ""
      ? "処理済み"
      : `処理済み: ${resolution.note}`;
  }
  return `不要として解決: ${resolution.reason}`;
}

function safeExternalUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username !== "" || parsed.password !== "") {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isSafeArtifactName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".."
    && !name.includes("/") && !name.includes("\\") && !name.includes("\0");
}

interface ArtifactReferenceProps {
  label: string;
  artifactName: string;
  artifactUrl: string;
}

function ArtifactReference(props: ArtifactReferenceProps): JSX.Element {
  const [phase, setPhase] = useState<"idle" | "checking" | "available" | "unavailable">("idle");
  const activeRef = useRef(true);
  const operationRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    setPhase("idle");
    inFlightRef.current = false;
    return () => {
      activeRef.current = false;
      inFlightRef.current = false;
      operationRef.current += 1;
    };
  }, [props.artifactUrl, props.label]);

  const verifyAttachment = async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const operation = ++operationRef.current;
    setPhase("checking");
    try {
      const response = await fetch(props.artifactUrl, {
        method: "HEAD",
        credentials: "same-origin",
      });
      if (!activeRef.current || operation !== operationRef.current) return;
      setPhase(response.ok ? "available" : "unavailable");
    } catch {
      if (!activeRef.current || operation !== operationRef.current) return;
      setPhase("unavailable");
    } finally {
      if (activeRef.current && operation === operationRef.current) {
        inFlightRef.current = false;
      }
    }
  };

  return (
    <div className="min-w-0 space-y-1.5">
      <p className="whitespace-pre-wrap break-words text-sm text-ink">
        <span className="text-xs font-semibold text-ink-muted">添付</span> {props.label}
      </p>
      <p className="break-all font-mono text-xs text-ink-muted">{props.artifactName}</p>
      {phase === "available" ? (
        <a className="text-sm text-accent-strong hover:underline" href={props.artifactUrl}>
          添付を開く
        </a>
      ) : (
        <button
          type="button"
          className={SECONDARY_BUTTON_CLASS}
          disabled={phase === "checking"}
          onClick={() => {
            void verifyAttachment();
          }}
        >
          {phase === "checking" ? "添付を確認中" : phase === "unavailable" ? "添付を再確認" : "添付を確認"}
        </button>
      )}
      {phase === "unavailable" ? (
        <p role="alert" className="text-xs text-danger-strong">添付を取得できません</p>
      ) : null}
    </div>
  );
}

function HumanDecisionReference(props: {
  link: HumanDecisionLink;
  requestId: string;
  requestTaskId: string;
  index: number;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const { link } = props;
  if (link.type === "url") {
    const href = safeExternalUrl(link.url);
    return (
      <div className="min-w-0 space-y-1">
        <p className="whitespace-pre-wrap break-words text-sm text-ink">
          <span className="text-xs font-semibold text-ink-muted">URL</span> {link.label}
        </p>
        {href === null ? (
          <p role="alert" className="break-words text-xs text-danger-strong">参照URLが不正です</p>
        ) : (
          <a
            className="block break-all text-sm text-accent-strong hover:underline"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {href}
          </a>
        )}
      </div>
    );
  }
  if (link.type === "task") {
    return (
      <div className="min-w-0 space-y-1">
        <p className="whitespace-pre-wrap break-words text-sm text-ink">
          <span className="text-xs font-semibold text-ink-muted">タスク</span> {link.label}
        </p>
        <button
          type="button"
          className="break-all text-left font-mono text-sm text-accent-strong hover:underline"
          onClick={() => props.onOpenTask(link.taskId)}
        >
          {link.taskId}
        </button>
      </div>
    );
  }

  if (!isSafeArtifactName(link.artifactName)) {
    return (
      <div className="min-w-0 space-y-1">
        <p className="whitespace-pre-wrap break-words text-sm text-ink">
          <span className="text-xs font-semibold text-ink-muted">添付</span> {link.label}
        </p>
        <p role="alert" className="break-words text-xs text-danger-strong">添付名が不正です</p>
      </div>
    );
  }
  const artifactUrl = `/task/${encodeURIComponent(props.requestTaskId)}/artifact/${encodeURIComponent(link.artifactName)}`;
  return (
    <ArtifactReference
      key={`${props.requestId}:${props.index}:${props.requestTaskId}:${link.artifactName}:${link.label}`}
      label={link.label}
      artifactName={link.artifactName}
      artifactUrl={artifactUrl}
    />
  );
}

function HumanDecisionAnswerForm(props: HumanDecisionCardProps): JSX.Element {
  const { request, submission } = props;
  const [localDraft, setLocalDraft] = useState<HumanDecisionDraft>({ choiceId: "", text: "", comment: "" });
  const draft = props.draft ?? localDraft;
  const { choiceId, text, comment } = draft;
  const updateDraft = (patch: Partial<HumanDecisionDraft>): void => {
    const next = { ...draft, ...patch };
    setLocalDraft(next);
    props.onDraftChange?.(next);
  };
  const [localError, setLocalError] = useState<string | null>(null);
  const normalizedComment = comment.trim();
  const commentValid = normalizedComment.length <= 12_000;

  const invoke = (answer: HumanDecisionAnswer): void => {
    if (!commentValid) {
      setLocalError("コメントは12000文字以内で入力してください");
      return;
    }
    setLocalError(null);
    try {
      const operation = normalizedComment === ""
        ? props.onSubmit(request.id, answer)
        : props.onSubmit(request.id, answer, normalizedComment);
      void operation.catch((error: unknown) => {
        setLocalError(`回答の送信に失敗しました: ${errorMessage(error)}`);
      });
    } catch (error: unknown) {
      setLocalError(`回答の送信に失敗しました: ${errorMessage(error)}`);
    }
  };

  const retry = (): void => {
    setLocalError(null);
    try {
      void props.onRetry(request.id).catch((error: unknown) => {
        setLocalError(`回答の再送に失敗しました: ${errorMessage(error)}`);
      });
    } catch (error: unknown) {
      setLocalError(`回答の再送に失敗しました: ${errorMessage(error)}`);
    }
  };

  const answerControls = request.kind === "approval" ? (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        disabled={!submission.canSubmit || !commentValid}
        onClick={() => invoke({ kind: "approval", outcome: "approve" })}
      >
        承認する
      </button>
      <button
        type="button"
        className={DANGER_BUTTON_CLASS}
        disabled={!submission.canSubmit || !commentValid}
        onClick={() => invoke({ kind: "approval", outcome: "reject" })}
      >
        却下する
      </button>
    </div>
  ) : request.kind === "review" ? (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        disabled={!submission.canSubmit || !commentValid}
        onClick={() => invoke({ kind: "review", outcome: "accepted" })}
      >
        受け入れる
      </button>
      <button
        type="button"
        className={SECONDARY_BUTTON_CLASS}
        disabled={!submission.canSubmit || !commentValid}
        onClick={() => invoke({ kind: "review", outcome: "changes_requested" })}
      >
        修正を依頼する
      </button>
    </div>
  ) : request.choices.length > 0 ? (
    <div className="space-y-2">
      <label className={LABEL_CLASS}>
        判断の選択肢
        <select
          className={FIELD_CLASS}
          value={choiceId}
          disabled={!submission.canSubmit}
          onChange={(event) => {
            updateDraft({ choiceId: event.currentTarget.value });
            setLocalError(null);
          }}
        >
          <option value="">選択してください</option>
          {request.choices.map((choice) => (
            <option key={choice.id} value={choice.id}>{choice.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        disabled={!submission.canSubmit || !commentValid
          || choiceId === "" || !request.choices.some((choice) => choice.id === choiceId)}
        onClick={() => invoke({ kind: "decision", choiceId })}
      >
        回答を送信
      </button>
    </div>
  ) : (
    <div className="space-y-2">
      <label className={LABEL_CLASS}>
        判断の回答
        <textarea
          className={`${FIELD_CLASS} min-h-24 whitespace-pre-wrap break-words`}
          maxLength={12_000}
          value={text}
          disabled={!submission.canSubmit}
          onChange={(event) => {
            updateDraft({ text: event.currentTarget.value });
            setLocalError(null);
          }}
        />
      </label>
      <button
        type="button"
        className={PRIMARY_BUTTON_CLASS}
        disabled={!submission.canSubmit || !commentValid
          || text.trim() === "" || text.trim().length > 12_000}
        onClick={() => invoke({ kind: "decision", text: text.trim() })}
      >
        回答を送信
      </button>
    </div>
  );

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <label className={LABEL_CLASS}>
        コメント（任意）
        <textarea
          className={`${FIELD_CLASS} min-h-20 whitespace-pre-wrap break-words`}
          maxLength={12_000}
          value={comment}
          disabled={!submission.canSubmit}
          onChange={(event) => {
            updateDraft({ comment: event.currentTarget.value });
            setLocalError(null);
          }}
        />
      </label>
      {answerControls}
      {submission.phase === "submitting" ? (
        <p role="status" className="text-sm text-ink-muted">送信中</p>
      ) : null}
      {submission.phase === "uncertain" ? (
        <div className="space-y-2 rounded-md bg-warn-soft p-2">
          {submission.pendingAnswer !== null ? (
            <div className="space-y-1 text-sm text-warn-strong">
              <p className="whitespace-pre-wrap break-words">
                保留中の回答: {answerLabel(request, submission.pendingAnswer.answer)}
              </p>
              {submission.pendingAnswer.comment !== undefined
                && submission.pendingAnswer.comment !== null
                && submission.pendingAnswer.comment !== "" ? (
                  <p className="whitespace-pre-wrap break-words">
                    保留中のコメント: {submission.pendingAnswer.comment}
                  </p>
                ) : null}
            </div>
          ) : null}
          <p role="alert" className="whitespace-pre-wrap break-words text-sm text-warn-strong">
            送信結果を確認できません。同じ回答を再送できます
            {submission.error === null ? "" : `: ${submission.error}`}
          </p>
          <button
            type="button"
            className={SECONDARY_BUTTON_CLASS}
            disabled={!submission.canRetry}
            onClick={retry}
          >
            同じ回答を再送
          </button>
        </div>
      ) : null}
      {submission.phase === "rejected" && submission.error !== null ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger-strong">
          回答は受け付けられませんでした: {submission.error}
        </p>
      ) : null}
      {localError !== null ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger-strong">{localError}</p>
      ) : null}
    </div>
  );
}

function HumanDecisionCardContent(props: HumanDecisionCardProps): JSX.Element {
  const { request } = props;
  const overdue = request.deadlineAt !== null && request.deadlineAt < Math.floor(Date.now() / 1000);
  const resolution = resolutionLabel(request);
  const waiting = request.status === "waiting_human" && request.answerRevision === 0;

  return (
    <Card className="min-w-0 space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge tone="neutral">{KIND_LABELS[request.kind]}</Badge>
        <Badge tone={statusTone(request.status)}>{props.statusLabel ?? STATUS_LABELS[request.status]}</Badge>
        <span className="min-w-0 break-all font-mono text-xs text-ink-muted">{request.id}</span>
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="whitespace-pre-wrap break-words text-base font-semibold text-ink">{request.title}</h3>
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-ink">{request.question}</p>
      </div>
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-muted">タスク</dt>
        <dd className="min-w-0">
          <button
            type="button"
            className="break-all text-left font-mono text-accent-strong hover:underline"
            onClick={() => props.onOpenTask(request.taskId)}
          >
            {request.taskId}
          </button>
        </dd>
        <dt className="text-ink-muted">依頼元</dt>
        <dd className="min-w-0 break-all font-mono text-ink">{request.ownerOrchestratorId}</dd>
        {request.action !== null ? (
          <>
            <dt className="text-ink-muted">操作</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-ink">{request.action}</dd>
          </>
        ) : null}
        {request.targetRevision !== null ? (
          <>
            <dt className="text-ink-muted">対象revision</dt>
            <dd className="min-w-0 break-all font-mono text-ink">
              {request.targetRevision.kind}: {request.targetRevision.value}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-muted">無回答時</dt>
        <dd className="min-w-0 break-words text-ink">{DEFAULT_OUTCOME_LABELS[request.defaultOutcome]}</dd>
        {request.deadlineAt !== null ? (
          <>
            <dt className="text-ink-muted">期限</dt>
            <dd className="min-w-0 break-words tabular-nums text-ink">
              {formatTimestamp(request.deadlineAt)}{overdue ? "（期限超過）" : ""}
            </dd>
          </>
        ) : null}
        {request.relatedRequestId !== null ? (
          <>
            <dt className="text-ink-muted">関連依頼</dt>
            <dd className="min-w-0 break-all font-mono text-ink">{request.relatedRequestId}</dd>
          </>
        ) : null}
      </dl>
      {request.links.length > 0 ? (
        <div className="space-y-2 border-t border-line pt-3">
          <h4 className="text-xs font-semibold text-ink-muted">参照</h4>
          <ul className="space-y-3">
            {request.links.map((link, index) => (
              <li key={`${link.type}:${index}`} className="min-w-0">
                <HumanDecisionReference
                  link={link}
                  requestId={request.id}
                  requestTaskId={request.taskId}
                  index={index}
                  onOpenTask={props.onOpenTask}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {request.answerRevision === 1 && request.answer !== null ? (
        <div className="space-y-1 rounded-md bg-surface-muted p-2 text-sm">
          <p className="whitespace-pre-wrap break-words text-ink">回答: {answerLabel(request, request.answer)}</p>
          {request.answerComment !== null ? (
            <p className="whitespace-pre-wrap break-words text-ink">コメント: {request.answerComment}</p>
          ) : null}
          <p className="tabular-nums text-xs text-ink-muted">回答日時: {formatTimestamp(request.answeredAt)}</p>
          {request.answerProvenance !== null ? (
            <p className="break-all text-xs text-ink-muted">
              回答元（ローカル申告）: {request.answerProvenance.actorId}
            </p>
          ) : null}
        </div>
      ) : null}
      {request.status === "claimed" ? (
        <p className="break-all text-xs text-ink-muted">
          受領先: {request.claimantOrchestratorId ?? "-"} / {request.claimantSessionId ?? "-"}
          {request.claimantGeneration === null ? "" : ` / generation ${request.claimantGeneration}`}
        </p>
      ) : null}
      {resolution !== null ? (
        <p className="whitespace-pre-wrap break-words rounded-md bg-ok-soft p-2 text-sm text-ok-strong">
          解決結果: {resolution}
        </p>
      ) : null}
      {request.cancelReason !== null ? (
        <p className="whitespace-pre-wrap break-words rounded-md bg-surface-muted p-2 text-sm text-ink">
          取消理由: {request.cancelReason}
        </p>
      ) : null}
      <p className="text-xs text-ink-muted">
        この回答は判断内容を記録するだけで、worker起動・merge・publish・遠隔permissionを実行しません。
      </p>
      {waiting ? <HumanDecisionAnswerForm {...props} /> : null}
    </Card>
  );
}

export function HumanDecisionCard(props: HumanDecisionCardProps): JSX.Element {
  return <HumanDecisionCardContent key={props.request.id} {...props} />;
}
