// =============================================================================
// supervisor 状態バッジ + kill-switch トグルパネル（docs/contract.md §23.3）。
// ヘッダに常駐するバッジをクリックすると launchd 状態・最終 tick・各ステージの
// kill-switch トグルを表示するパネルが展開する。破壊的操作ではないため確認ダイアログは出さない。
// =============================================================================

import type { JSX } from "react";
import { useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import type { TaskStatus } from "@hachi/core";
import { useSupervisorStatus } from "../hooks/use-supervisor-status.js";
import { useRuntimeResources } from "../hooks/use-runtime-resources.js";
import { formatIsoTimestamp, formatTimestamp } from "../lib/format.js";
import type {
  RuntimeResourceEligibilityEvidence,
  RuntimeResourceLeaseResponse,
  RuntimeResourcesResponse,
  SupervisorStatus,
} from "../../shared/api-types.js";

type BadgeTone = "success" | "neutral" | "danger";

export interface SupervisorCounts {
  counts: Record<TaskStatus, number>;
  retryPending: number;
}

export interface SupervisorPanelProps {
  boardCounts?: SupervisorCounts | null;
}

/** バッジの色調（緑=loaded&&pid / 灰=停止 / 赤=supervisor.disabled 存在。docs/contract.md §23.3） */
function badgeTone(data: SupervisorStatus | null): BadgeTone {
  if (data === null) {
    return "neutral";
  }
  const globalDisabled = data.stages.find((s) => s.name === "supervisor")?.disabled === true;
  if (globalDisabled) {
    return "danger";
  }
  if (data.launchd !== null && data.launchd.pid !== null) {
    return "success";
  }
  return "neutral";
}

const DOT_CLASSES: Record<BadgeTone, string> = {
  success: "bg-ok-strong",
  neutral: "bg-ink-muted",
  danger: "bg-danger-strong",
};

const BUTTON_CLASSES: Record<BadgeTone, string> = {
  success: "border-ok-strong/30 bg-ok-soft text-ok-strong",
  neutral: "border-line bg-surface text-ink-muted",
  danger: "border-danger-strong/30 bg-danger-soft text-danger-strong",
};

function CountsInfo(props: { boardCounts: SupervisorCounts | null }): JSX.Element {
  if (props.boardCounts === null) {
    return <p className="text-xs italic text-ink-muted">board counts は未取得です</p>;
  }

  const total = Object.values(props.boardCounts.counts).reduce((sum, count) => sum + count, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-ink-muted">total</span>
        <span className="font-mono text-ink">{total}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink">
        {Object.entries(props.boardCounts.counts).map(([status, count]) => (
          <div key={status} className="contents">
            <dt className="truncate text-ink-muted">{status}</dt>
            <dd className="text-right font-mono tabular-nums">{count}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="truncate text-warn-strong">retry_pending</dt>
          <dd className="text-right font-mono tabular-nums text-warn-strong">
            {props.boardCounts.retryPending}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function LaunchdInfo(props: { launchd: SupervisorStatus["launchd"] }): JSX.Element {
  const { launchd } = props;
  if (launchd === null) {
    return (
      <p className="text-xs italic text-ink-muted">
        launchd 情報を取得できません（未ロード or launchctl 失敗）
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink">
      <dt className="text-ink-muted">label</dt>
      <dd className="truncate" title={launchd.label}>
        {launchd.label}
      </dd>
      <dt className="text-ink-muted">loaded</dt>
      <dd>{launchd.loaded ? "true" : "false"}</dd>
      <dt className="text-ink-muted">pid</dt>
      <dd className="tabular-nums">{launchd.pid ?? "-"}</dd>
      <dt className="text-ink-muted">lastExitCode</dt>
      <dd className="tabular-nums">{launchd.lastExitCode ?? "-"}</dd>
    </dl>
  );
}

function LastTickInfo(props: { lastTick: SupervisorStatus["lastTick"] }): JSX.Element {
  const { lastTick } = props;
  if (lastTick === null) {
    return <p className="text-xs italic text-ink-muted">tick ログがありません</p>;
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-ink-muted">{formatIsoTimestamp(lastTick.at)}</p>
      <ul className="space-y-0.5 text-xs text-ink">
        {lastTick.stages.map((stage) => (
          <li key={stage.name} className="flex items-center justify-between gap-2 tabular-nums">
            <span>{stage.name}</span>
            <span className={stage.skipped ? "text-warn-strong" : "text-ink-muted"}>
              {stage.skipped ? "skipped" : `actions:${stage.actions}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StageToggleRow(props: { name: string; disabled: boolean; onToggle: (disabled: boolean) => void }): JSX.Element {
  const { name, disabled, onToggle } = props;
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-xs text-ink">{name}</span>
      <Switch.Root
        checked={!disabled}
        onCheckedChange={(checked) => onToggle(!checked)}
        aria-label={`${name} を${disabled ? "有効化" : "無効化"}`}
        className="relative h-5 w-9 cursor-pointer rounded-full bg-surface-muted outline-none transition-colors data-[state=checked]:bg-accent"
      >
        <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-surface ring-1 ring-line transition-transform data-[state=checked]:translate-x-4" />
      </Switch.Root>
    </div>
  );
}

function EpochTime(props: { value: number | null }): JSX.Element {
  return <>{formatTimestamp(props.value)}</>;
}

function EvidenceInfo(props: { evidence: RuntimeResourceEligibilityEvidence }): JSX.Element {
  const { evidence } = props;
  return (
    <div className="mt-2 rounded-md border border-line bg-surface-muted p-2" data-testid="runtime-eligibility">
      <p className="text-[11px] font-semibold text-ink">
        autoEligible: <span className="text-danger-strong">false</span>
      </p>
      <ul className="mt-1 space-y-0.5 text-[11px] text-ink-muted">
        {evidence.failedConditions.map((condition) => (
          <li key={condition} className="break-words [overflow-wrap:anywhere]">
            {condition}
          </li>
        ))}
      </ul>
    </div>
  );
}

function LeaseInfo(props: { lease: RuntimeResourceLeaseResponse }): JSX.Element {
  const { lease } = props;
  return (
    <details className="rounded-md border border-line bg-surface" data-testid="runtime-lease">
      <summary className="cursor-pointer break-words px-2 py-2 text-xs font-semibold text-ink [overflow-wrap:anywhere]">
        {lease.id} · {lease.state}
      </summary>
      <div className="space-y-3 border-t border-line px-2 py-2 text-xs">
        <dl className="grid min-w-0 grid-cols-[minmax(5rem,auto)_minmax(0,1fr)] gap-x-2 gap-y-1">
          <dt className="text-ink-muted">owner</dt>
          <dd className="break-words [overflow-wrap:anywhere]">{lease.ownerTaskId ?? "-"} / run {lease.ownerRunId ?? "-"}</dd>
          <dt className="text-ink-muted">controller</dt>
          <dd className="break-words [overflow-wrap:anywhere]">{lease.controllerOrchestratorId ?? "-"}</dd>
          <dt className="text-ink-muted">fence</dt>
          <dd className="font-mono tabular-nums">{lease.fence}</dd>
          <dt className="text-ink-muted">expiry</dt>
          <dd><EpochTime value={lease.expiresAt} /></dd>
          <dt className="text-ink-muted">heartbeat</dt>
          <dd><EpochTime value={lease.heartbeatAt} /></dd>
          <dt className="text-ink-muted">policy</dt>
          <dd>{lease.cleanupPolicy} / {lease.managed ? "managed" : "unmanaged"} / {lease.ephemeral ? "ephemeral" : "persistent"}</dd>
          <dt className="text-ink-muted">terminal</dt>
          <dd className="break-words [overflow-wrap:anywhere]">{lease.terminalReason || "-"}</dd>
        </dl>

        {lease.staleReasons.length > 0 ? (
          <p className="break-words text-warn-strong [overflow-wrap:anywhere]">stale: {lease.staleReasons.join(", ")}</p>
        ) : null}

        <div className="space-y-2">
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">members</h5>
          {lease.members.length === 0 ? <p className="italic text-ink-muted">member なし</p> : null}
          {lease.members.map((member) => (
            <div key={member.id} className="min-w-0 rounded-md border border-line p-2" data-testid="runtime-member">
              <p className="break-words font-medium text-ink [overflow-wrap:anywhere]">{member.id}</p>
              <p className="break-words text-ink-muted [overflow-wrap:anywhere]">
                {member.kind} · {member.state} · {member.display || "-"} · objectFence {member.objectFence}
              </p>
              {member.port === null ? null : (
                <p className="break-words text-ink-muted [overflow-wrap:anywhere]">
                  port {member.port.hostIp}:{member.port.hostPort ?? "-"} → {member.port.containerPort ?? "-"}
                </p>
              )}
              <p className="text-ink-muted">
                provenance {member.provenanceRecorded ? "recorded" : "missing"} / verified <EpochTime value={member.provenanceVerifiedAt} /> / observed <EpochTime value={member.lastObservedAt} />
              </p>
              <EvidenceInfo evidence={member.eligibility} />
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">cleanup requests</h5>
          {lease.cleanupRequests.length === 0 ? <p className="italic text-ink-muted">request なし</p> : null}
          {lease.cleanupRequests.map((request) => (
            <div key={request.id} className="min-w-0 rounded-md border border-line p-2" data-testid="cleanup-request">
              <p className="break-words font-medium text-ink [overflow-wrap:anywhere]">{request.id}</p>
              <p className="break-words text-ink-muted [overflow-wrap:anywhere]">
                {request.decisionClass} · {request.status} · {request.reason || "-"}
              </p>
              <p className={request.leaseFenceMatches && request.memberSnapshotMatches ? "text-ok-strong" : "text-danger-strong"}>
                fence {request.leaseFenceMatches ? "match" : "mismatch"} / snapshot {request.memberSnapshotMatches ? "match" : "mismatch"}
              </p>
              <p className="break-words text-ink-muted [overflow-wrap:anywhere]">
                claimant {request.claimantSessionId || "-"} gen {request.claimantGeneration ?? "-"} / approval {request.approvedBy || "-"} gen {request.approvalGeneration ?? "-"}
              </p>
              <p className="break-words text-ink-muted [overflow-wrap:anywhere]">
                executor {request.executorId || "-"} gen {request.executorGeneration} / attempts {request.attempts} / backoff <EpochTime value={request.nextAttemptAt} /> / resolution <EpochTime value={request.resolvedAt} />
              </p>
              {request.lastError === "" ? null : <p className="break-words text-danger-strong [overflow-wrap:anywhere]">{request.lastError}</p>}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function RuntimeResourcesInfo(props: {
  data: RuntimeResourcesResponse | null;
  loading: boolean;
  error: string | null;
  degraded: boolean;
}): JSX.Element {
  if (props.loading && props.data === null) {
    return <p className="text-xs text-ink-muted">resource health を読み込み中...</p>;
  }
  if (props.error !== null && props.data === null) {
    return (
      <p className={props.degraded ? "text-xs text-warn-strong" : "text-xs text-danger-strong"}>
        {props.degraded ? "resource health API は未提供です" : props.error}
      </p>
    );
  }
  if (props.data === null || props.data.leases.length === 0) {
    return <p className="text-xs italic text-ink-muted">runtime resource lease はありません</p>;
  }
  const { summary } = props.data;
  return (
    <div className="min-w-0 space-y-2" data-testid="runtime-resources-readonly">
      {props.error === null ? null : <p className="text-xs text-danger-strong">更新失敗: {props.error}</p>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-muted">leases</dt><dd className="text-right tabular-nums">{summary.total}</dd>
        <dt className="text-ink-muted">active</dt><dd className="text-right tabular-nums">{summary.active}</dd>
        <dt className="text-ink-muted">stale</dt><dd className="text-right tabular-nums">{summary.stale}</dd>
        <dt className="text-ink-muted">expired</dt><dd className="text-right tabular-nums">{summary.expired}</dd>
        <dt className="text-ink-muted">cleanup 待ち</dt><dd className="text-right tabular-nums">{summary.cleanupPending}</dd>
        <dt className="text-ink-muted">quarantined</dt><dd className="text-right tabular-nums">{summary.quarantined}</dd>
        <dt className="text-ink-muted">legacy / never</dt><dd className="text-right tabular-nums">{summary.legacyNever}</dd>
      </dl>
      <div className="space-y-2">
        {props.data.leases.map((lease) => <LeaseInfo key={lease.id} lease={lease} />)}
      </div>
    </div>
  );
}

export function SupervisorPanel(props: SupervisorPanelProps): JSX.Element {
  const { data, error, toggle } = useSupervisorStatus();
  const runtimeResources = useRuntimeResources();
  const [open, setOpen] = useState(false);

  const offCount = data?.stages.filter((s) => s.disabled).length ?? 0;
  const tone = badgeTone(data);
  const boardCounts = props.boardCounts ?? null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="supervisor 状態"
        title={offCount > 0 ? `supervisor (${offCount} stages off)` : "supervisor"}
        className={`inline-flex h-9 w-9 items-center justify-center rounded-md border transition ${BUTTON_CLASSES[tone]}`}
      >
        <span className={`h-2 w-2 rounded-full ${DOT_CLASSES[tone]}`} aria-hidden="true" />
        <span className="sr-only">supervisor</span>
      </button>

      {open ? (
        <>
          {/* パネル外クリックで閉じる薄い透明背景（Radix Popover 等の追加依存を避けるための最小実装） */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-2 max-h-[80vh] w-[min(90vw,20rem)] space-y-3 overflow-y-auto rounded-md border border-line bg-surface p-3 sm:w-80">
            {error !== null ? <p className="text-xs text-danger-strong">{error}</p> : null}
            {data === null ? (
              <p className="text-xs text-ink-muted">読み込み中...</p>
            ) : (
              <>
                <section>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    counts
                  </h3>
                  <CountsInfo boardCounts={boardCounts} />
                </section>
                <section>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    launchd
                  </h3>
                  <LaunchdInfo launchd={data.launchd} />
                </section>
                <section>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    最終 tick
                  </h3>
                  <LastTickInfo lastTick={data.lastTick} />
                </section>
                <section>
                  <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                    kill-switch
                  </h3>
                  <div className="divide-y divide-line">
                    {data.stages.map((stage) => (
                      <StageToggleRow
                        key={stage.name}
                        name={stage.name}
                        disabled={stage.disabled}
                        onToggle={(disabled) => toggle(stage.name, disabled)}
                      />
                    ))}
                  </div>
                </section>
              </>
            )}
            <section data-testid="runtime-resource-health" className="min-w-0">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                resource health
              </h3>
              <RuntimeResourcesInfo {...runtimeResources} />
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
