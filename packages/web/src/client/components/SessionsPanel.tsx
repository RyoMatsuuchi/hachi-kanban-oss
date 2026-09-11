// =============================================================================
// セッション一覧ページ + 単体セッションページ（docs/contract.md §28）。
// 一覧モーダルは廃止し、/sessions と /session/:sessionId の専用画面として描画する。
// =============================================================================

import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  fetchSession,
  fetchSessionLive,
  fetchSessionMessages,
  fetchSessionTranscript,
  fetchSessionTranscriptRaw,
  type SessionsScope,
} from "../lib/api.js";
import { formatElapsed, providerLabel } from "../lib/format.js";
import { useDocumentTitleBase } from "../lib/document-title.js";
import { useRunningSessions } from "../hooks/use-running-sessions.js";
import type {
  SessionLiveResponse,
  SessionMessageEntry,
  SessionMessagesResponse,
  SessionTranscriptRawEntry,
  SessionTranscriptRawLimitReason,
  WebRunningSession,
} from "../../shared/api-types.js";
import { Badge, type BadgeTone } from "./Badge.js";

const LIVE_POLL_INTERVAL_MS = 2_500;
const DIRECT_LIVE_POLL_INTERVAL_MS = 3_000;
const LIVE_ELAPSED_TICK_MS = 1_000;
const DIRECT_LIVE_TAIL_LINES = 200;

/** 全文トランスクリプトビューでの本文折りたたみ閾値（文字数）。これを超えたら省略表示にする。 */
export const TRANSCRIPT_RAW_TEXT_TRUNCATE_LENGTH = 500;
/** 全文トランスクリプトビューでの本文折りたたみ閾値（行数）。文字数条件と OR で判定する。 */
export const TRANSCRIPT_RAW_TEXT_TRUNCATE_LINES = 10;

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 16) {
    return sessionId;
  }
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-6)}`;
}

function sessionPath(sessionId: string): string {
  return `/session/${encodeURIComponent(sessionId)}`;
}

function openStandaloneSession(sessionId: string): void {
  window.open(sessionPath(sessionId), "_blank", "width=720,height=900");
}

function entryKey(entry: SessionMessageEntry, index: number): string {
  return `${entry.id ?? `missing-${index}`}`;
}

/**
 * 連続する text_delta（ストリーミングの断片。1文字ずつ届くこともある）を1件に連結する。
 * 断片ごとに block 行を描くと1文字ずつ改行されて崩れるため、描画前にまとめる（contract §13.5）。
 */
function isTextEntry(entry: SessionMessageEntry): boolean {
  return entry.type === "text_delta" || entry.type === "text";
}

function hasVisibleText(entry: SessionMessageEntry): boolean {
  return textOf(entry).trim() !== "";
}

function hasRawText(entry: SessionMessageEntry): boolean {
  return textOf(entry) !== "";
}

export function mergeTextDeltas(entries: SessionMessageEntry[]): SessionMessageEntry[] {
  const merged: SessionMessageEntry[] = [];
  for (const entry of entries) {
    const last = merged[merged.length - 1];
    if (isTextEntry(entry) && last !== undefined && isTextEntry(last)) {
      merged[merged.length - 1] = {
        ...last,
        text: (typeof last.text === "string" ? last.text : "") + (typeof entry.text === "string" ? entry.text : ""),
      };
    } else {
      merged.push(entry);
    }
  }
  return merged;
}

function textOf(entry: SessionMessageEntry): string {
  return typeof entry.text === "string" ? entry.text : "";
}

function formatResultMeta(entry: SessionMessageEntry): string {
  const parts: string[] = [];
  if (typeof entry.costUsd === "number") {
    parts.push(`costUsd=${entry.costUsd}`);
  }
  if (typeof entry.turns === "number") {
    parts.push(`turns=${entry.turns}`);
  }
  if (typeof entry.durationMs === "number") {
    parts.push(`durationMs=${entry.durationMs}`);
  }
  return parts.join(" ");
}

function isConversationEntry(entry: SessionMessageEntry): boolean {
  switch (entry.type) {
    case "user_prompt":
      return hasVisibleText(entry);
    case "text":
    case "text_delta":
      return hasVisibleText(entry);
    case "result":
      return hasVisibleText(entry) || formatResultMeta(entry) !== "";
    default:
      return false;
  }
}

function isConversationCandidate(entry: SessionMessageEntry): boolean {
  if (isTextEntry(entry)) {
    return hasRawText(entry);
  }
  return isConversationEntry(entry);
}

function isToolEvent(entry: SessionMessageEntry): boolean {
  return entry.type === "tool_start" || entry.type === "tool_end";
}

function latestRunningStatsEntry(entries: SessionMessageEntry[]): SessionMessageEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "running_stats") {
      return entry;
    }
  }
  return null;
}

function shouldRenderDetailedEntry(entry: SessionMessageEntry, latestStats: SessionMessageEntry | null): boolean {
  if (isTextEntry(entry)) {
    return hasVisibleText(entry);
  }
  if (isConversationEntry(entry)) {
    return true;
  }
  if (entry.type === "running_stats") {
    return entry !== latestStats;
  }
  return true;
}

export function visibleSessionEntries(
  entries: SessionMessageEntry[],
  showDetailedEvents: boolean,
): SessionMessageEntry[] {
  if (!showDetailedEvents) {
    return mergeTextDeltas(entries.filter((entry) => isConversationCandidate(entry))).filter((entry) =>
      isConversationEntry(entry),
    );
  }

  const latestStats = latestRunningStatsEntry(entries);
  return mergeTextDeltas(entries).filter((entry) => shouldRenderDetailedEntry(entry, latestStats));
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export interface RunningStatsPill {
  text: string;
  elapsed: string | null;
  outputTokens: number | null;
}

export function latestRunningStatsPill(entries: SessionMessageEntry[]): RunningStatsPill | null {
  const stats = latestRunningStatsEntry(entries);
  if (stats === null) {
    return null;
  }

  const elapsed = typeof stats.durationMs === "number" ? formatDurationMs(stats.durationMs) : null;
  const outputTokens = typeof stats.outputTokens === "number" && stats.outputTokens > 0 ? stats.outputTokens : null;
  const parts: string[] = [];
  if (elapsed !== null) {
    parts.push(`経過 ${elapsed}`);
  }
  if (outputTokens !== null) {
    parts.push(`out ${outputTokens}`);
  }
  if (parts.length === 0) {
    return null;
  }
  return { text: parts.join(" · "), elapsed, outputTokens };
}

function liveStatusPill(
  entries: SessionMessageEntry[],
  startedAt: number,
  nowMs: number,
  liveActive: boolean,
): RunningStatsPill | null {
  const statsPill = latestRunningStatsPill(entries);
  if (!liveActive) {
    return statsPill;
  }

  const elapsed = formatDurationMs(nowMs - startedAt * 1000);
  const outputTokens = statsPill?.outputTokens ?? null;
  const parts = [`経過 ${elapsed}`];
  if (outputTokens !== null) {
    parts.push(`out ${outputTokens}`);
  }
  return { text: parts.join(" · "), elapsed, outputTokens };
}

function formatLastReceived(lastReceivedAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - lastReceivedAtMs) / 1000));
  return `最終受信 ${seconds}秒前`;
}

function stringField(entry: SessionMessageEntry, key: string): string | null {
  const value = entry[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function formatToolEventLabel(entry: SessionMessageEntry): string {
  const label =
    stringField(entry, "toolName") ??
    stringField(entry, "tool_name") ??
    stringField(entry, "name") ??
    stringField(entry, "kind") ??
    (typeof entry.type === "string" && entry.type !== "" ? entry.type : "tool");
  return `🔧 ${label}`;
}

function formatStatusEntry(entry: SessionMessageEntry): string {
  return `status ${typeof entry.state === "string" && entry.state !== "" ? entry.state : "unknown"}`;
}

function formatRunningStatsEntry(entry: SessionMessageEntry): string {
  const parts = ["running_stats"];
  if (typeof entry.durationMs === "number") {
    parts.push(`durationMs=${entry.durationMs}`);
  }
  if (typeof entry.inputTokens === "number") {
    parts.push(`inputTokens=${entry.inputTokens}`);
  }
  if (typeof entry.outputTokens === "number") {
    parts.push(`outputTokens=${entry.outputTokens}`);
  }
  return parts.join(" ");
}

function formatProgressEntry(entry: SessionMessageEntry): string {
  if (entry.type === "status") {
    return formatStatusEntry(entry);
  }
  if (entry.type === "running_stats") {
    return formatRunningStatsEntry(entry);
  }
  return `event ${typeof entry.type === "string" && entry.type !== "" ? entry.type : "missing"}`;
}

function isDoneResponse(response: SessionMessagesResponse): boolean {
  return response.state === "idle" && response.messages.some((entry) => entry.type === "result");
}

/** effort 表示テキストを組み立てる。null なら非表示 */
export function formatEffortLabel(effort: string | null, effortDelivery: string | null): string | null {
  if (effort === null) {
    return null;
  }
  if (effortDelivery === "none") {
    return `effort ${effort}（未配信）`;
  }
  return `effort ${effort}`;
}

function stateLabel(state: WebRunningSession["state"]): string {
  return state === "running" ? "実行中" : "終了済み";
}

function stateTone(state: WebRunningSession["state"]): BadgeTone {
  return state === "running" ? "info" : "neutral";
}

function roleLabel(role: WebRunningSession["role"]): string {
  return role === "reviewer" ? "レビュー" : "実装";
}

function roleTone(role: WebRunningSession["role"]): BadgeTone {
  return role === "reviewer" ? "reviewer" : "info";
}

function taskStatusTone(status: WebRunningSession["taskStatus"]): BadgeTone {
  switch (status) {
    case "blocked":
      return "warning";
    case "review":
      return "reviewer";
    case "done":
      return "success";
    case "archived":
      return "neutral";
    case "needs-integration":
      return "warning";
    case "ready":
      return "info";
    default:
      return "neutral";
  }
}

function tenantChipLabel(tenant: string): string {
  return tenant === "" ? "tenant:-" : tenant;
}

function TenantChip(props: { tenant: string }): JSX.Element {
  const label = tenantChipLabel(props.tenant);
  return (
    <span
      title={`tenant: ${props.tenant === "" ? "-" : props.tenant}`}
      className="inline-flex min-w-0 max-w-[12rem] items-center rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-muted sm:max-w-[16rem]"
    >
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}

function TerminalLine(props: { entry: SessionMessageEntry }): JSX.Element {
  const { entry } = props;
  if (isToolEvent(entry)) {
    return <div className="terminal-line text-terminal-muted">{formatToolEventLabel(entry)}</div>;
  }
  switch (entry.type) {
    case "user_prompt":
      return (
        <div className="terminal-line whitespace-pre-wrap break-words text-terminal-user">
          <span className="terminal-prefix text-terminal-user-strong">$ user</span>
          {textOf(entry)}
        </div>
      );
    case "text":
    case "text_delta":
      return <div className="terminal-line whitespace-pre-wrap break-words text-terminal-ink">{textOf(entry)}</div>;
    case "result": {
      const meta = formatResultMeta(entry);
      return (
        <div className="space-y-1">
          {hasVisibleText(entry) ? (
            <div className="terminal-line whitespace-pre-wrap break-words text-terminal-result">
              <span className="terminal-prefix text-terminal-result-strong">result</span>
              {textOf(entry)}
            </div>
          ) : null}
          {meta !== "" ? <div className="terminal-line text-terminal-muted">{meta}</div> : null}
        </div>
      );
    }
    case "status":
    case "running_stats":
      return <div className="terminal-line text-terminal-muted">{formatProgressEntry(entry)}</div>;
    default:
      return <div className="terminal-line text-terminal-muted">{formatProgressEntry(entry)}</div>;
  }
}

interface LiveViewProps {
  session: WebRunningSession;
}

export function SessionLiveView(props: LiveViewProps): JSX.Element {
  const { session } = props;
  const sessionKey = `${session.provider}:${session.serverUrl}:${session.sessionId}:${session.state}`;
  const [entries, setEntries] = useState<SessionMessageEntry[]>([]);
  const [savedTranscript, setSavedTranscript] = useState<string | null>(null);
  const [savedTranscriptSource, setSavedTranscriptSource] = useState<"artifact" | "direct-live" | null>(null);
  const [directLiveNotice, setDirectLiveNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [done, setDone] = useState<boolean>(session.state === "ended");
  const [pollingStopped, setPollingStopped] = useState<boolean>(session.state === "ended");
  const [stickToBottom, setStickToBottom] = useState<boolean>(true);
  const [showDetailedEvents, setShowDetailedEvents] = useState<boolean>(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [lastReceivedAtMs, setLastReceivedAtMs] = useState<number | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const activeSessionKeyRef = useRef<string>(sessionKey);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const lastDirectLiveTextRef = useRef<string>("");
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const visibleEntries = useMemo(
    () => visibleSessionEntries(entries, showDetailedEvents),
    [entries, showDetailedEvents],
  );
  const liveActive = session.state === "running" && !done && !pollingStopped;
  const directLiveSession = session.transport === "direct" || session.serverUrl === "direct";
  const statsPill = useMemo(
    () => liveStatusPill(entries, session.startedAt, nowMs, liveActive),
    [entries, liveActive, nowMs, session.startedAt],
  );
  const lastReceivedText =
    liveActive && lastReceivedAtMs !== null ? formatLastReceived(lastReceivedAtMs, nowMs) : null;

  const loadTranscriptFallback = useCallback(
    (requestSessionKey: string): void => {
      const controller = new AbortController();
      controllersRef.current.add(controller);
      fetchSessionTranscript(
        {
          sessionId: session.sessionId,
          taskId: session.taskId,
        },
        controller.signal,
      )
        .then((response) => {
          if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
            return;
          }
          setEntries([]);
          setSavedTranscript(response.text);
          setSavedTranscriptSource("artifact");
          setDirectLiveNotice(null);
          setDone(true);
          setPollingStopped(true);
          setError(null);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
          if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
            return;
          }
          setDirectLiveNotice(null);
          setError(err instanceof Error ? err.message : String(err));
          setDone(true);
          setPollingStopped(true);
          setLoading(false);
        })
        .finally(() => {
          controllersRef.current.delete(controller);
        });
    },
    [session.sessionId, session.taskId],
  );

  const applyDirectLiveResponse = useCallback(
    (response: SessionLiveResponse): void => {
      const changed = response.text !== lastDirectLiveTextRef.current;
      lastDirectLiveTextRef.current = response.text;
      setEntries([]);
      setSavedTranscript(response.text);
      setSavedTranscriptSource("direct-live");
      setDirectLiveNotice(response.text === "" ? "起動直後です。ログ生成を待っています" : null);
      setDone(false);
      setPollingStopped(false);
      setError(null);
      setLoading(false);
      if (changed) {
        setLastReceivedAtMs(Date.now());
      }
    },
    [],
  );

  const loadDirectLive = useCallback((): void => {
    const requestSessionKey = sessionKey;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    fetchSession(session.sessionId, controller.signal)
      .then((sessionResponse) => {
        if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
          return undefined;
        }
        if (sessionResponse.session.state === "ended") {
          loadTranscriptFallback(requestSessionKey);
          return undefined;
        }
        return fetchSessionLive(
          {
            sessionId: session.sessionId,
            taskId: session.taskId,
            tail: DIRECT_LIVE_TAIL_LINES,
          },
          controller.signal,
        );
      })
      .then((response) => {
        if (response === undefined) {
          return;
        }
        if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
          return;
        }
        applyDirectLiveResponse(response);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setEntries([]);
          setSavedTranscript(null);
          setSavedTranscriptSource(null);
          setDirectLiveNotice("起動直後です。ログ生成を待っています");
          setDone(false);
          setPollingStopped(false);
          setError(null);
        } else {
          setDirectLiveNotice(null);
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      })
      .finally(() => {
        controllersRef.current.delete(controller);
      });
  }, [applyDirectLiveResponse, loadTranscriptFallback, session.sessionId, session.taskId, sessionKey]);

  const loadRunningMessages = useCallback((): void => {
    const requestSessionKey = sessionKey;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    fetchSessionMessages(
      {
        sessionId: session.sessionId,
        provider: session.provider,
        server: session.serverUrl,
      },
      controller.signal,
    )
      .then((response) => {
        if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
          return;
        }
        const nextEntries: SessionMessageEntry[] = [];
        response.messages.forEach((entry, index) => {
          const key = entryKey(entry, index);
          if (!seenIdsRef.current.has(key)) {
            seenIdsRef.current.add(key);
            nextEntries.push(entry);
          }
        });
        if (nextEntries.length > 0) {
          setEntries((current) => [...current, ...nextEntries]);
          setLastReceivedAtMs(Date.now());
        }
        setSavedTranscript(null);
        setSavedTranscriptSource(null);
        setDirectLiveNotice(null);
        setDone(isDoneResponse(response));
        setPollingStopped(false);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        if (controller.signal.aborted || activeSessionKeyRef.current !== requestSessionKey) {
          return;
        }
        if (err instanceof ApiError && err.status === 501) {
          setError("direct transport のライブ閲覧は非対応です");
          setPollingStopped(true);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      })
      .finally(() => {
        controllersRef.current.delete(controller);
      });
  }, [session.provider, session.serverUrl, session.sessionId, sessionKey]);

  const loadEndedMessages = useCallback((): void => {
    const requestSessionKey = sessionKey;
    loadTranscriptFallback(requestSessionKey);
  }, [loadTranscriptFallback, sessionKey]);

  const load = useCallback((): void => {
    if (session.state === "ended") {
      loadEndedMessages();
    } else if (directLiveSession) {
      loadDirectLive();
    } else {
      loadRunningMessages();
    }
  }, [directLiveSession, loadDirectLive, loadEndedMessages, loadRunningMessages, session.state]);

  useEffect(() => {
    activeSessionKeyRef.current = sessionKey;
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    seenIdsRef.current = new Set();
    lastDirectLiveTextRef.current = "";
    setEntries([]);
    setSavedTranscript(null);
    setSavedTranscriptSource(null);
    setDirectLiveNotice(null);
    setError(null);
    setLoading(true);
    setDone(session.state === "ended");
    setPollingStopped(session.state === "ended");
    setStickToBottom(true);
    setShowDetailedEvents(false);
    setNowMs(Date.now());
    setLastReceivedAtMs(null);
    load();
    return () => {
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
    };
  }, [load, session.state, sessionKey]);

  useEffect(() => {
    if (!liveActive) {
      return undefined;
    }
    setNowMs(Date.now());
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, LIVE_ELAPSED_TICK_MS);
    return () => window.clearInterval(timer);
  }, [liveActive, sessionKey]);

  useEffect(() => {
    if (session.state !== "running" || done || pollingStopped) {
      return undefined;
    }
    const intervalMs = directLiveSession ? DIRECT_LIVE_POLL_INTERVAL_MS : LIVE_POLL_INTERVAL_MS;
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        load();
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [directLiveSession, done, load, pollingStopped, session.state]);

  useEffect(() => {
    if (!stickToBottom) {
      return;
    }
    const element = terminalRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [savedTranscript, stickToBottom, visibleEntries]);

  const onTerminalScroll = (): void => {
    const element = terminalRef.current;
    if (element === null) {
      return;
    }
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setStickToBottom(distance < 32);
  };

  const returnToLatest = (): void => {
    const element = terminalRef.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
    setStickToBottom(true);
  };

  const savedLog = savedTranscript !== null;
  const directLiveLog = savedTranscriptSource === "direct-live";

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={session.provider === "codex" ? "codex" : "claude"}>{providerLabel(session.provider)}</Badge>
            <Badge tone={roleTone(session.role)}>{roleLabel(session.role)}</Badge>
            <Badge tone={stateTone(session.state)}>{stateLabel(session.state)}</Badge>
            <TenantChip tenant={session.tenant} />
            {/* モデル名の隣に effort を併記（セッション一覧と同じパターン） */}
            <span className="inline-flex items-center rounded-md bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-muted">
              {session.model === "" ? "model:-" : session.model}
              {(() => {
                const effortLabel = formatEffortLabel(session.effort, session.effortDelivery);
                return effortLabel !== null ? ` · ${effortLabel}` : "";
              })()}
            </span>
            {savedLog ? <Badge tone={directLiveLog ? "success" : "warning"}>{directLiveLog ? "direct live" : "保存ログ"}</Badge> : null}
            <span className="font-mono text-xs text-ink-muted">{shortSessionId(session.sessionId)}</span>
            {!done && pollingStopped ? <Badge tone="warning">停止</Badge> : null}
            {!done && !pollingStopped ? <Badge tone="success">live</Badge> : null}
            {statsPill !== null ? (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-ok-strong/30 bg-ok-soft px-2.5 py-1 font-mono text-[11px] font-medium text-ok-strong">
                {liveActive ? (
                  <span className="relative inline-flex h-2.5 w-2.5" aria-hidden="true">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok-strong opacity-70" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-ok-strong" />
                  </span>
                ) : null}
                {statsPill.text}
              </span>
            ) : null}
            {lastReceivedText !== null ? (
              <span className="font-mono text-[11px] text-ink-muted">{lastReceivedText}</span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm font-medium text-ink">{session.taskTitle}</p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <button
            type="button"
            aria-pressed={showDetailedEvents}
            onClick={() => setShowDetailedEvents((current) => !current)}
            className={`inline-flex min-h-9 items-center rounded-md border px-3 py-1.5 text-xs font-medium transition ${
              showDetailedEvents
                ? "border-accent/30 bg-accent-soft text-accent-strong hover:bg-accent-soft"
                : "border-line text-ink-muted hover:bg-surface-muted"
            }`}
          >
            詳細イベント
          </button>
          <a
            href={`/task/${encodeURIComponent(session.taskId)}`}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-9 items-center rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-surface-muted"
          >
            タスクを開く
          </a>
        </div>
      </div>
      {/* ターミナル領域。最下部にいる間は自動追従（stickToBottom）、離れると右下に
          「最新に戻る」フローティングボタンを表示する。relative でボタンを重ねる。 */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={terminalRef}
          onScroll={onTerminalScroll}
          className="h-full overflow-y-auto bg-terminal-canvas px-3 py-3 font-mono text-[13px] leading-6 text-terminal-ink sm:px-4 sm:py-4"
        >
          {loading && entries.length === 0 && savedTranscript === null ? (
            <div className="terminal-line text-terminal-muted">loading...</div>
          ) : null}
          {savedTranscript !== null ? (
            <>
              <div className="terminal-line text-terminal-warn">
                {directLiveLog ? "（direct live）" : "（保存ログ）"}
              </div>
              <div className="terminal-line whitespace-pre-wrap break-words text-terminal-ink">{savedTranscript}</div>
            </>
          ) : (
            visibleEntries.map((entry, index) => (
              <TerminalLine key={`${entryKey(entry, index)}-${index}`} entry={entry} />
            ))
          )}
          {directLiveNotice !== null ? <div className="terminal-line text-terminal-muted">{directLiveNotice}</div> : null}
          {error !== null ? <div className="terminal-line text-terminal-danger">{error}</div> : null}
          {done && !savedLog ? <div className="terminal-line text-terminal-result-strong">session complete</div> : null}
        </div>
        {!stickToBottom ? (
          <button
            type="button"
            onClick={returnToLatest}
            aria-label="最新に戻る"
            className="absolute bottom-3 right-3 z-10 flex min-h-10 items-center gap-1.5 rounded-md border border-accent-strong/40 bg-accent-strong px-3 py-2 text-xs font-semibold text-on-accent transition hover:brightness-95 sm:bottom-4 sm:right-4"
          >
            最新に戻る ↓
          </button>
        ) : null}
      </div>
    </section>
  );
}

// =============================================================================
// 全文トランスクリプトビュー（GET /api/session/:sessionId/transcript-raw）。
// SessionLiveView とは別系統の表示で、bridge/direct-live の整形済み表示では拾えない
// ネイティブ JSONL の生行を、行番号付きでページング表示する。既存表示は変更しない。
// =============================================================================

/** 種別ごとの表示可否。既定は会話本体（user/assistant）のみ表示し、tool/other は畳む（非表示）。 */
interface TranscriptRawKindFilter {
  user: boolean;
  assistant: boolean;
  tool: boolean;
  other: boolean;
}

const DEFAULT_TRANSCRIPT_RAW_KIND_FILTER: TranscriptRawKindFilter = {
  user: true,
  assistant: true,
  tool: false,
  other: false,
};

const TRANSCRIPT_RAW_ENTRY_LIMIT = 2_000;

interface TranscriptRawEntryWindow {
  entries: SessionTranscriptRawEntry[];
  evictedBeforeLine: number | null;
}

/** 保持上限を超えた場合は古い側だけを退避し、再取得用の境界行を返す。 */
function capTranscriptRawEntries(entries: SessionTranscriptRawEntry[]): TranscriptRawEntryWindow {
  if (entries.length <= TRANSCRIPT_RAW_ENTRY_LIMIT) {
    return { entries, evictedBeforeLine: null };
  }
  const retainedEntries = entries.slice(-TRANSCRIPT_RAW_ENTRY_LIMIT);
  return {
    entries: retainedEntries,
    evictedBeforeLine: retainedEntries[0]?.line ?? null,
  };
}

function mergeTranscriptRawLimits(
  current: readonly SessionTranscriptRawLimitReason[],
  incoming: readonly SessionTranscriptRawLimitReason[] | undefined,
): SessionTranscriptRawLimitReason[] {
  const present = new Set([...current, ...(incoming ?? [])]);
  return (["response-bytes", "raw-line-bytes"] as const).filter((reason) => present.has(reason));
}

function transcriptKindTone(kind: SessionTranscriptRawEntry["kind"]): BadgeTone {
  switch (kind) {
    case "user":
      return "info";
    case "assistant":
      return "success";
    case "tool":
      return "warning";
    default:
      return "neutral";
  }
}

/** 本文が折りたたみ対象（長すぎる）かどうか。文字数・行数のどちらか一方を超えたら対象。 */
function isTranscriptTextTruncated(text: string): boolean {
  return (
    text.length > TRANSCRIPT_RAW_TEXT_TRUNCATE_LENGTH ||
    text.split("\n").length > TRANSCRIPT_RAW_TEXT_TRUNCATE_LINES
  );
}

/** 折りたたみ時のプレビュー本文を作る（行数制限を先に適用し、その後に文字数制限を適用する）。 */
function truncateTranscriptText(text: string): string {
  const lines = text.split("\n");
  const lineLimited =
    lines.length > TRANSCRIPT_RAW_TEXT_TRUNCATE_LINES
      ? lines.slice(0, TRANSCRIPT_RAW_TEXT_TRUNCATE_LINES).join("\n")
      : text;
  return lineLimited.length > TRANSCRIPT_RAW_TEXT_TRUNCATE_LENGTH
    ? lineLimited.slice(0, TRANSCRIPT_RAW_TEXT_TRUNCATE_LENGTH)
    : lineLimited;
}

function TranscriptRawEntryBody(props: { entry: SessionTranscriptRawEntry }): JSX.Element {
  const { entry } = props;
  const [expanded, setExpanded] = useState<boolean>(false);
  const truncated = isTranscriptTextTruncated(entry.text);
  const displayText = !truncated || expanded ? entry.text : truncateTranscriptText(entry.text);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
        <span className="font-mono">L{entry.line}</span>
        <Badge tone={transcriptKindTone(entry.kind)} compact>
          {entry.kind}
        </Badge>
        {entry.timestamp !== null ? <span className="font-mono">{entry.timestamp}</span> : null}
        {entry.unparsed ? (
          <Badge tone="warning" compact title="JSON.parse に失敗した行（書き込み中の途中行等）">
            unparsed
          </Badge>
        ) : null}
      </div>
      <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-ink">{displayText}</div>
      {truncated ? (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="text-[11px] font-medium text-accent-strong hover:underline"
        >
          {expanded ? "折りたたむ" : "もっと見る"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * tool/other 種別は個別にも <details> で畳んでおく（種別トグルで表示させた後も、
 * 生JSON由来の長い1行が一覧を占有しないようにするため）。user/assistant は直接描画する。
 */
function TranscriptRawEntryItem(props: { entry: SessionTranscriptRawEntry }): JSX.Element {
  const { entry } = props;
  if (entry.kind === "tool" || entry.kind === "other") {
    return (
      <details className="rounded-md border border-line bg-surface-muted px-2 py-1">
        <summary className="cursor-pointer select-none font-mono text-[11px] text-ink-muted">
          L{entry.line} · {entry.kind}
          {entry.rawType !== null ? ` (${entry.rawType})` : ""}
        </summary>
        <div className="mt-1">
          <TranscriptRawEntryBody entry={entry} />
        </div>
      </details>
    );
  }
  return (
    <div className="rounded-md border border-line px-2 py-1">
      <TranscriptRawEntryBody entry={entry} />
    </div>
  );
}

interface TranscriptRawViewProps {
  session: WebRunningSession;
}

/**
 * 全文トランスクリプトビュー。デフォルト非表示（トグルで開閉）で、開いている間だけ
 * tail 取得・running 中のポーリングを行う（API 負荷を常時かけない）。
 */
export function SessionTranscriptRawView(props: TranscriptRawViewProps): JSX.Element {
  const { session } = props;
  const { sessionId, taskId } = session;
  const [open, setOpen] = useState<boolean>(false);
  const [entries, setEntries] = useState<SessionTranscriptRawEntry[]>([]);
  const [found, setFound] = useState<boolean | null>(null);
  const [reasonText, setReasonText] = useState<string | null>(null);
  const [totalLines, setTotalLines] = useState<number>(0);
  const [hasMoreBefore, setHasMoreBefore] = useState<boolean>(false);
  const [limitedBy, setLimitedBy] = useState<SessionTranscriptRawLimitReason[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const [hasEvictedBefore, setHasEvictedBefore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<TranscriptRawKindFilter>(DEFAULT_TRANSCRIPT_RAW_KIND_FILTER);
  const controllersRef = useRef<Set<AbortController>>(new Set());
  const entriesRef = useRef<SessionTranscriptRawEntry[]>([]);
  /**
   * `[open, taskId, sessionId]` の組ごとの世代番号（契約 §28.6-8）。
   * abort だけでは足りない: fetch のモック実装や、abort 前に既に解決へ向かっている応答は
   * signal を見ずに then へ入りうる。「応答を適用してよいか」は必ずこの世代一致で判定する。
   */
  const generationRef = useRef<number>(0);
  // 過去方向読み取り用の先頭行番号。空行は entries に載らないため、response から独立保持する。
  const knownStartLineRef = useRef<number | null>(null);
  // ポーリング用に「取得済みの末尾行番号」を保持する（entries の再フィルタと独立させるため ref で持つ）。
  const knownEndLineRef = useRef<number>(0);
  /**
   * 前方読み取り（初回 tail ＋ incremental poll）の**単一**直列化ガード。
   * 初回 tail と poll で別々のガードを持つと、初回が poll 周期（2.5秒）より長引いたときに
   * 未初期化の `after: 0` で poll が走り、重複・逆順・cursor 後退が起きる。
   */
  const forwardInFlightRef = useRef<boolean>(false);
  /** 初回 tail が完了して cursor が確定したか。false の間は incremental poll を開始しない。 */
  const tailReadyRef = useRef<boolean>(false);

  const visibleEntries = useMemo(() => entries.filter((entry) => kindFilter[entry.kind]), [entries, kindFilter]);

  const toggleKind = useCallback((kind: keyof TranscriptRawKindFilter): void => {
    setKindFilter((current) => ({ ...current, [kind]: !current[kind] }));
  }, []);

  /**
   * session 切替・close で、進行中の全リクエストを打ち切り、entries / cursor / in-flight ガードを
   * 同時にリセットする（契約 §28.6-8）。世代を進めるので、既に飛んでいる応答は以後適用されない。
   * 新しい世代番号を返す。
   */
  const beginGeneration = useCallback((): number => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    knownStartLineRef.current = null;
    knownEndLineRef.current = 0;
    forwardInFlightRef.current = false;
    tailReadyRef.current = false;
    generationRef.current += 1;
    entriesRef.current = [];
    setEntries([]);
    setFound(null);
    setReasonText(null);
    setTotalLines(0);
    setHasMoreBefore(false);
    setLimitedBy([]);
    setLoadingOlder(false);
    setHasEvictedBefore(false);
    setError(null);
    return generationRef.current;
  }, []);

  // 初回ロード（open が true になったとき、または session が切り替わったとき）は tail を取得する。
  useEffect(() => {
    const generation = beginGeneration();
    if (!open) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    controllersRef.current.add(controller);
    // 初回 tail も「前方読み取り」の一種として同じガードを占有する。
    forwardInFlightRef.current = true;
    setLoading(true);
    fetchSessionTranscriptRaw({ sessionId, taskId }, controller.signal)
      .then((response) => {
        if (generationRef.current !== generation) {
          return;
        }
        if (response.found) {
          entriesRef.current = response.entries;
          setEntries(response.entries);
          setFound(true);
          setReasonText(null);
          setTotalLines(response.totalLines);
          setHasMoreBefore(response.hasMoreBefore);
          setLimitedBy(mergeTranscriptRawLimits([], response.limitedBy));
          knownStartLineRef.current = response.startLine;
          knownEndLineRef.current = response.endLine;
          tailReadyRef.current = true;
        } else {
          entriesRef.current = [];
          setEntries([]);
          setFound(false);
          setReasonText(response.reasonText);
          setHasMoreBefore(false);
          setLimitedBy([]);
          knownEndLineRef.current = 0;
        }
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      })
      .finally(() => {
        controllersRef.current.delete(controller);
        if (generationRef.current === generation) {
          forwardInFlightRef.current = false;
        }
      });
    return () => {
      controller.abort();
      controllersRef.current.delete(controller);
    };
  }, [beginGeneration, open, sessionId, taskId]);

  // アンマウント時は inflight リクエストを全て中断する。
  useEffect(() => {
    return () => {
      controllersRef.current.forEach((controller) => controller.abort());
      controllersRef.current.clear();
      // 応答が後から解決しても適用されないよう、世代も進めておく。
      generationRef.current += 1;
    };
  }, []);

  const loadOlder = useCallback((): void => {
    const beforeLine = knownStartLineRef.current;
    if (beforeLine === null || !hasMoreBefore || loadingOlder || hasEvictedBefore) {
      return;
    }
    const generation = generationRef.current;
    setLoadingOlder(true);
    const controller = new AbortController();
    controllersRef.current.add(controller);
    fetchSessionTranscriptRaw({ sessionId, taskId, before: beforeLine }, controller.signal)
      .then((response) => {
        if (generationRef.current !== generation) {
          return;
        }
        if (response.found) {
          const entryWindow = capTranscriptRawEntries([...response.entries, ...entriesRef.current]);
          entriesRef.current = entryWindow.entries;
          setEntries(entryWindow.entries);
          setHasMoreBefore(response.hasMoreBefore);
          setTotalLines(response.totalLines);
          setLimitedBy((current) => mergeTranscriptRawLimits(current, response.limitedBy));
          knownStartLineRef.current = entryWindow.evictedBeforeLine ?? response.startLine;
          if (entryWindow.evictedBeforeLine !== null) {
            setHasEvictedBefore(true);
          }
          setError(null);
        } else {
          setError(response.reasonText);
        }
      })
      .catch((err: unknown) => {
        if (generationRef.current !== generation) {
          return;
        }
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        controllersRef.current.delete(controller);
        // 世代が変わっていれば loadingOlder は beginGeneration が既に false へ戻している。
        // ここで触ると新しい session の状態を壊すため、同一世代のときだけ戻す。
        if (generationRef.current === generation) {
          setLoadingOlder(false);
        }
      });
  }, [hasEvictedBefore, hasMoreBefore, loadingOlder, sessionId, taskId]);

  const pollNewer = useCallback((): void => {
    // 前回の前方読み取りが完了していない場合は skip する（同じ after 値での重複送信・
    // entries への重複追記・cursor 後退を防ぐ）。
    if (forwardInFlightRef.current) {
      return;
    }
    const generation = generationRef.current;
    const tailRequest = !tailReadyRef.current;
    forwardInFlightRef.current = true;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    const params = tailRequest ? { sessionId, taskId } : { sessionId, taskId, after: knownEndLineRef.current };
    fetchSessionTranscriptRaw(params, controller.signal)
      .then((response) => {
        if (generationRef.current !== generation) {
          // session が切り替わった後に届いた応答。別セッションの entries / cursor を汚さない。
          return;
        }
        if (response.found) {
          if (tailRequest) {
            entriesRef.current = response.entries;
            setEntries(response.entries);
            setHasMoreBefore(response.hasMoreBefore);
            knownStartLineRef.current = response.startLine;
          } else if (response.entries.length > 0) {
            const entryWindow = capTranscriptRawEntries([...entriesRef.current, ...response.entries]);
            entriesRef.current = entryWindow.entries;
            setEntries(entryWindow.entries);
            if (entryWindow.evictedBeforeLine !== null) {
              knownStartLineRef.current = entryWindow.evictedBeforeLine;
              setHasEvictedBefore(true);
            }
          }
          setFound(true);
          setReasonText(null);
          setTotalLines(response.totalLines);
          setLimitedBy((current) => mergeTranscriptRawLimits(current, response.limitedBy));
          knownEndLineRef.current = Math.max(knownEndLineRef.current, response.endLine);
          tailReadyRef.current = true;
        } else {
          setFound(false);
          setReasonText(response.reasonText);
        }
      })
      .catch((err: unknown) => {
        // ポーリング失敗は都度エラー表示にせず、次回ポーリングに委ねる（既存 SessionLiveView と同様の方針）。
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
      })
      .finally(() => {
        controllersRef.current.delete(controller);
        if (generationRef.current === generation) {
          forwardInFlightRef.current = false;
        }
      });
  }, [sessionId, taskId]);

  // 開いている間・running中・タブが可視の間だけポーリングする（既存 SessionLiveView と同じ方針）。
  useEffect(() => {
    if (!open || session.state !== "running") {
      return undefined;
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        pollNewer();
      }
    }, LIVE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, pollNewer, session.state]);

  return (
    <section className="mt-2 overflow-hidden rounded-md border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={`inline-flex min-h-9 items-center rounded-md border px-3 py-1.5 text-xs font-medium transition ${
            open
              ? "border-accent/30 bg-accent-soft text-accent-strong hover:bg-accent-soft"
              : "border-line text-ink-muted hover:bg-surface-muted"
          }`}
        >
          {open ? "全文ログを閉じる" : "全文ログを表示"}
        </button>
        {open ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            {(["user", "assistant", "tool", "other"] as const).map((kind) => (
              <label key={kind} className="inline-flex items-center gap-1">
                <input type="checkbox" checked={kindFilter[kind]} onChange={() => toggleKind(kind)} />
                {kind}
              </label>
            ))}
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-line px-3 py-2">
          {loading && entries.length === 0 ? <p className="text-sm text-ink-muted">読み込み中...</p> : null}
          {error !== null ? (
            <div className="mb-2 rounded-md border border-danger-strong/30 bg-danger-soft px-2 py-1 text-xs text-danger-strong">
              {error}
            </div>
          ) : null}
          {limitedBy.includes("response-bytes") ? (
            <div className="mb-2 rounded-md border border-warn-strong/30 bg-warn-soft px-2 py-1 text-xs text-warn-strong">
              応答サイズ上限のため、この範囲の一部だけを表示しています
            </div>
          ) : null}
          {limitedBy.includes("raw-line-bytes") ? (
            <div className="mb-2 rounded-md border border-warn-strong/30 bg-warn-soft px-2 py-1 text-xs text-warn-strong">
              1 MiBを超える行は安全のため固定メッセージに置き換えました
            </div>
          ) : null}
          {found === false ? (
            <div className="rounded-md border border-warn-strong/30 bg-warn-soft px-2 py-1 text-xs text-warn-strong">
              {reasonText}
            </div>
          ) : null}
          {found === true || entries.length > 0 ? (
            <>
              {hasEvictedBefore ? (
                <div className="mb-2 rounded-md border border-warn-strong/30 bg-warn-soft px-2 py-1 text-xs text-warn-strong">
                  保持上限（2000 行）に達したため古い行は再取得が必要です
                </div>
              ) : null}
              {hasMoreBefore || hasEvictedBefore ? (
                <button
                  type="button"
                  onClick={loadOlder}
                  disabled={loadingOlder || hasEvictedBefore}
                  className="mb-2 inline-flex min-h-8 items-center rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-muted transition hover:bg-surface-muted disabled:opacity-60"
                >
                  {loadingOlder ? "読み込み中..." : "古いログを読み込む"}
                </button>
              ) : null}
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {visibleEntries.map((entry) => (
                  <TranscriptRawEntryItem key={entry.line} entry={entry} />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-ink-muted">
                全{totalLines}行中{" "}
                {entries.length > 0 ? `${entries[0]?.line}〜${entries[entries.length - 1]?.line}` : "-"}行を取得済み
              </p>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

interface SessionsViewProps {
  onOpenSession: (sessionId: string) => void;
}

export function SessionsView(props: SessionsViewProps): JSX.Element {
  const { onOpenSession } = props;
  const [scope, setScope] = useState<SessionsScope>("running");
  const sessions = useRunningSessions(scope);
  const sessionRows = sessions.data?.sessions ?? [];

  // document.title は lib/document-title.ts が単一所有する（docs/contract.md §37.7）。
  useDocumentTitleBase("セッション - hachi-kanban");

  return (
    <main className="w-full space-y-3 px-2 py-2 sm:px-4">
      <div className="flex w-full overflow-hidden rounded-md border border-line bg-surface p-1 sm:w-fit">
        <button
          type="button"
          onClick={() => setScope("running")}
          className={`min-h-9 flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition sm:flex-none ${
            scope === "running"
              ? "bg-accent-strong text-on-accent"
              : "text-ink-muted hover:bg-surface-muted"
          }`}
        >
          実行中
        </button>
        <button
          type="button"
          onClick={() => setScope("recent")}
          className={`min-h-9 flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition sm:flex-none ${
            scope === "recent"
              ? "bg-accent-strong text-on-accent"
              : "text-ink-muted hover:bg-surface-muted"
          }`}
        >
          以前のもの
        </button>
      </div>

      {sessions.error !== null ? (
        <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
          データ取得に失敗しました: {sessions.error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-line bg-surface">
        {sessions.loading && sessionRows.length === 0 ? (
          <p className="px-3 py-8 text-sm text-ink-muted">読み込み中...</p>
        ) : null}
        {sessionRows.length === 0 && !sessions.loading ? (
          <p className="px-3 py-8 text-sm text-ink-muted">
            {scope === "running" ? "実行中セッションはありません" : "以前のセッションはありません"}
          </p>
        ) : null}
        <ul className="divide-y divide-line">
          {sessionRows.map((session) => (
            <li
              key={`${session.provider}-${session.sessionId}`}
              className="flex flex-col gap-3 p-3 transition-colors hover:bg-surface-muted md:flex-row md:items-center"
            >
              <button
                type="button"
                onClick={() => onOpenSession(session.sessionId)}
                className="block min-w-0 flex-1 text-left"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={session.provider === "codex" ? "codex" : "claude"}>
                    {providerLabel(session.provider)}
                  </Badge>
                  <Badge tone={roleTone(session.role)}>{roleLabel(session.role)}</Badge>
                  <Badge tone={stateTone(session.state)}>{stateLabel(session.state)}</Badge>
                  <Badge tone={taskStatusTone(session.taskStatus)} title="task status">
                    {session.taskStatus}
                  </Badge>
                  <TenantChip tenant={session.tenant} />
                  <span className="font-mono text-xs text-ink-muted">{shortSessionId(session.sessionId)}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-sm font-semibold text-ink">
                  {session.taskTitle}
                </p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-ink-muted">
                  <span>
                    {session.model === "" ? "model:-" : session.model}
                    {(() => {
                      const effortLabel = formatEffortLabel(session.effort, session.effortDelivery);
                      return effortLabel !== null ? ` · ${effortLabel}` : "";
                    })()}
                  </span>
                  <span>{formatElapsed(session.startedAt)}</span>
                </div>
              </button>
              <div className="flex w-full shrink-0 flex-wrap items-start gap-2 sm:w-auto md:justify-end">
                <a
                  href={`/task/${encodeURIComponent(session.taskId)}`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex min-h-9 items-center rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-surface-muted"
                >
                  タスクを開く
                </a>
                <button
                  type="button"
                  onClick={() => openStandaloneSession(session.sessionId)}
                  className="inline-flex min-h-9 items-center rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-surface-muted"
                >
                  別ウィンドウ ⧉
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}

interface SessionPageViewProps {
  sessionId: string;
}

export function SessionPageView(props: SessionPageViewProps): JSX.Element {
  const { sessionId } = props;
  const [session, setSession] = useState<WebRunningSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchSession(sessionId, controller.signal)
      .then((response) => {
        setSession(response.session);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setSession(null);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId]);

  // §27.1 の単独ウィンドウ識別子 `▶ <タスクタイトル>` をベースとして登録する。
  // 先頭の実行中ワーカー数プレフィックスは document-title 側が付与する（§37.7）。
  useDocumentTitleBase(session === null ? "セッション - hachi-kanban" : `▶ ${session.taskTitle}`);

  return (
    <main className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-hidden px-2 py-2 sm:px-4">
      {loading ? <p className="py-16 text-center text-sm text-ink-muted">読み込み中...</p> : null}
      {error !== null ? (
        <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
          セッション取得に失敗しました: {error}
        </div>
      ) : null}
      {session !== null ? (
        <>
          <SessionLiveView session={session} />
          {/* 全文トランスクリプトビュー（既定非表示）。SessionLiveView とは別系統の生ログ表示。 */}
          <SessionTranscriptRawView key={session.sessionId} session={session} />
        </>
      ) : null}
    </main>
  );
}
