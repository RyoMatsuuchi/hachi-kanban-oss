// =============================================================================
// コメント時系列。agent.message.v1 は intent バッジ付き整形 + <details> 生JSON（docs/contract.md §14.3/§20.2）。
// =============================================================================

import type { JSX } from "react";
import type { AgentMessageV1, CommentRow, RunRow } from "@hachi/core";
import { useMemo, useState } from "react";
import type { CommentMessages } from "../../shared/api-types.js";
import { Card } from "./Card.js";
import { Badge, type BadgeTone } from "./Badge.js";
import { Markdown } from "./Markdown.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/Collapsible.js";
import { ScrollArea } from "./ui/ScrollArea.js";
import { ToggleGroup, ToggleGroupItem } from "./ui/ToggleGroup.js";
import { formatTimestamp } from "../lib/format.js";

// agent.message.v1 のフェンスドブロック検出パターン（@hachi/core messages.ts の FENCE_REGEX と同一）。
// コメント本文の「地の文」を Markdown 表示する際、フェンスドブロック部分は AgentMessageBlock で
// 別途構造化表示するため二重描画を避けるべく取り除く。@hachi/core は better-sqlite3 等の
// Node 専用依存を含むためクライアントバンドルへは実行時 import できず（型のみ import 可、
// api-types.ts 参照）、ここでは正規表現のみをそのまま複製して用いる。
const AGENT_MESSAGE_FENCE_REGEX = /```agent-message-v1\s*\n[\s\S]*?```/g;
const HAS_AGENT_MESSAGE_FENCE_REGEX = /```agent-message-v1\s*\n[\s\S]*?```/;

type CommentSegment = "all" | "latest" | "messages";
type CommentRunRole = "worker" | "reviewer" | "rework" | "orchestrator / human";

interface RunMeta {
  role?: string;
}

export interface GroupedComment {
  comment: CommentRow;
  parsed: CommentMessages | undefined;
  hasAgentMessageBlock: boolean;
  attributionSource: "message-session" | "interval" | "none";
}

export interface CommentGroup {
  key: string;
  comments: GroupedComment[];
  run: RunRow | null;
  latestCreatedAt: number;
}

function parseRunMeta(raw: string): RunMeta {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as RunMeta) : {};
  } catch {
    return {};
  }
}

function findMessageRun(parsed: CommentMessages | undefined, runs: readonly RunRow[]): RunRow | null {
  if (parsed === undefined) {
    return null;
  }
  const sessionIds = new Set(
    parsed.messages
      .map((message) => message.from.sessionId)
      .filter((sessionId) => sessionId !== ""),
  );
  return [...runs]
    .filter((run) => sessionIds.has(run.sessionId))
    .sort((left, right) => right.startedAt - left.startedAt || right.id - left.id)[0] ?? null;
}

function findIntervalRun(comment: CommentRow, runs: readonly RunRow[], now: number): RunRow | null {
  return [...runs]
    .filter((run) => (
      run.startedAt <= comment.createdAt &&
      comment.createdAt <= (run.endedAt ?? now)
    ))
    .sort((left, right) => right.startedAt - left.startedAt || right.id - left.id)[0] ?? null;
}

/** contract §32.5 の優先順でコメントを run に帰属させ、run 外を末尾へ送る。 */
export function groupCommentsByRun(
  comments: readonly CommentRow[],
  messages: Readonly<Record<number, CommentMessages>>,
  runs: readonly RunRow[],
  now: number = Math.floor(Date.now() / 1000),
): CommentGroup[] {
  const groups = new Map<string, CommentGroup>();

  for (const comment of comments) {
    const parsed = messages[comment.id];
    const messageRun = findMessageRun(parsed, runs);
    const intervalRun = messageRun === null ? findIntervalRun(comment, runs, now) : null;
    const run = messageRun ?? intervalRun;
    const key = run === null ? "outside" : `run:${run.id}`;
    const groupedComment: GroupedComment = {
      comment,
      parsed,
      hasAgentMessageBlock: HAS_AGENT_MESSAGE_FENCE_REGEX.test(comment.body),
      attributionSource: messageRun !== null
        ? "message-session"
        : intervalRun !== null
          ? "interval"
          : "none",
    };
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        comments: [groupedComment],
        run,
        latestCreatedAt: comment.createdAt,
      });
    } else {
      existing.comments.push(groupedComment);
      existing.latestCreatedAt = Math.max(existing.latestCreatedAt, comment.createdAt);
    }
  }

  const grouped = [...groups.values()];
  for (const group of grouped) {
    group.comments.sort((left, right) => (
      left.comment.createdAt - right.comment.createdAt || left.comment.id - right.comment.id
    ));
  }

  return grouped.sort((left, right) => {
    if (left.run === null) {
      return right.run === null ? 0 : 1;
    }
    if (right.run === null) {
      return -1;
    }
    return right.latestCreatedAt - left.latestCreatedAt ||
      right.run.startedAt - left.run.startedAt ||
      right.run.id - left.run.id;
  });
}

/** コメント本文から agent.message.v1 フェンスドブロックを除いた「地の文」を取り出す */
function stripAgentMessageBlocks(body: string): string {
  return body.replace(AGENT_MESSAGE_FENCE_REGEX, "").replace(/\n{3,}/g, "\n\n").trim();
}

function AgentMessageBlock(props: { message: AgentMessageV1 }): JSX.Element {
  const { message } = props;
  return (
    <div className="mt-3 rounded-md border border-accent/30 bg-accent-soft p-3">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="font-medium text-accent-strong">intent</dt>
        <dd>
          <Badge tone="info">{message.intent}</Badge>
        </dd>
        <dt className="font-medium text-accent-strong">from</dt>
        <dd className="break-all text-ink">
          {message.from.role} / {message.from.provider === "" ? "-" : message.from.provider} / session=
          {message.from.sessionId === "" ? "-" : message.from.sessionId}
        </dd>
        <dt className="font-medium text-accent-strong">to</dt>
        <dd className="break-all text-ink">
          {message.to.role} / task={message.to.taskId}
        </dd>
        <dt className="font-medium text-accent-strong">idempotencyKey</dt>
        <dd className="break-all text-ink">{message.idempotencyKey}</dd>
      </dl>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer rounded-md text-ink-muted outline-none transition hover:text-ink focus-visible:ring-2 focus-visible:ring-accent">
          生 JSON
        </summary>
        <ScrollArea
          className="mt-2 rounded-md border border-line bg-surface-muted"
          viewportClassName="max-h-72"
        >
          <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed text-ink">
            {JSON.stringify(message, null, 2)}
          </pre>
        </ScrollArea>
      </details>
    </div>
  );
}

function CommentItem(props: { comment: CommentRow; parsed: CommentMessages | undefined }): JSX.Element {
  const { comment, parsed } = props;
  const bodyText = stripAgentMessageBlocks(comment.body);
  return (
    <div className="rounded-md border border-line bg-surface-muted/40 p-3">
      <div className="mb-2 text-xs text-ink-muted">
        {comment.author} · <span className="tabular-nums">{formatTimestamp(comment.createdAt)}</span>
      </div>
      {bodyText !== "" ? <Markdown source={bodyText} /> : null}
      {parsed !== undefined
        ? parsed.messages.map((message, index) => (
            // 同一コメント内のメッセージは並び替わらない静的配列のため index key で問題ない
            <AgentMessageBlock key={index} message={message} />
          ))
        : null}
      {parsed !== undefined && parsed.errors.length > 0 ? (
        <p className="mt-2 text-xs text-danger-strong">
          agent.message.v1 ブロックの解析に失敗しました（{parsed.errors.length}件）
        </p>
      ) : null}
    </div>
  );
}

function shortId(value: string | number): string {
  return String(value).slice(0, 8);
}

function groupRole(group: CommentGroup): CommentRunRole {
  if (group.run === null) {
    return "orchestrator / human";
  }
  const role = parseRunMeta(group.run.meta).role;
  if (role === "reviewer" || role === "rework") {
    return role;
  }
  return "worker";
}

function roleTone(role: CommentRunRole): BadgeTone {
  switch (role) {
    case "reviewer":
      return "reviewer";
    case "rework":
      return "warning";
    case "orchestrator / human":
      return "success";
    default:
      return "info";
  }
}

function groupTimeRange(group: CommentGroup): string {
  const createdAts = group.comments.map(({ comment }) => comment.createdAt);
  const startedAt = group.run?.startedAt ?? Math.min(...createdAts);
  const endedAt = group.run?.endedAt ?? (group.run === null ? Math.max(...createdAts) : null);
  return `${formatTimestamp(startedAt)} – ${formatTimestamp(endedAt)}`;
}

function CommentGroupView(props: { group: CommentGroup; defaultOpen: boolean }): JSX.Element {
  const { group, defaultOpen } = props;
  const role = groupRole(group);
  const runLabel = group.run === null ? "run 外" : `run ${shortId(group.run.id)}`;
  const sessionLabel = group.run === null ? "session -" : `session ${shortId(group.run.sessionId)}`;

  return (
    <Collapsible
      className="rounded-md border border-line bg-surface-muted/40"
      data-comment-group={group.key}
      defaultOpen={defaultOpen}
    >
      <h3>
        <CollapsibleTrigger className="group flex w-full min-w-0 items-start gap-2 rounded-md px-3 py-2 text-left outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent-strong/40">
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-xs text-ink-muted transition-transform group-data-[state=open]:rotate-90">▶</span>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={roleTone(role)} compact>{role}</Badge>
              <span className="font-mono text-xs font-medium text-ink">{runLabel}</span>
              <span className="font-mono text-xs text-ink-muted">{sessionLabel}</span>
              <span className="text-xs text-ink-muted">{group.comments.length} 件</span>
            </span>
            <span className="text-[11px] tabular-nums text-ink-muted">{groupTimeRange(group)}</span>
          </span>
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent className="border-t border-line px-3 py-3">
        <div className="space-y-3">
          {group.comments.map(({ comment, parsed }) => (
            <CommentItem key={comment.id} comment={comment} parsed={parsed} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function CommentsCard(props: {
  comments: CommentRow[];
  messages: Record<number, CommentMessages>;
  runs: RunRow[];
}): JSX.Element {
  const { comments, messages, runs } = props;
  const [segment, setSegment] = useState<CommentSegment>("all");
  const groups = useMemo(
    () => groupCommentsByRun(comments, messages, runs),
    [comments, messages, runs],
  );
  const visibleGroups = useMemo(() => {
    if (segment === "latest") {
      const latestRun = groups.find((group) => group.run !== null);
      return latestRun === undefined ? [] : [latestRun];
    }
    if (segment === "messages") {
      return groups
        .map((group) => ({
          ...group,
          comments: group.comments.filter((comment) => comment.hasAgentMessageBlock),
        }))
        .filter((group) => group.comments.length > 0);
    }
    return groups;
  }, [groups, segment]);

  return (
    <Card title={`コメント（${comments.length}）`}>
      {comments.length === 0 ? (
        <p className="text-sm italic text-ink-muted">コメントはありません</p>
      ) : (
        <div className="space-y-3">
          <ToggleGroup
            type="single"
            value={segment}
            onValueChange={(value) => {
              if (value === "all" || value === "latest" || value === "messages") {
                setSegment(value);
              }
            }}
            aria-label="コメントの絞り込み"
          >
            <ToggleGroupItem value="all">すべて</ToggleGroupItem>
            <ToggleGroupItem value="latest">最新の run</ToggleGroupItem>
            <ToggleGroupItem value="messages">メッセージのみ</ToggleGroupItem>
          </ToggleGroup>

          {visibleGroups.length === 0 ? (
            <p className="text-sm italic text-ink-muted">該当するコメントはありません</p>
          ) : (
            <div className="space-y-2">
              {visibleGroups.map((group, index) => (
                <CommentGroupView
                  key={`${segment}:${group.key}`}
                  group={group}
                  defaultOpen={index === 0}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
