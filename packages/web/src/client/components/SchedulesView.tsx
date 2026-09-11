// =============================================================================
// スケジュール管理画面（/schedules）。一覧・作成/編集・有効化トグル・削除を提供する。
// =============================================================================

import type { ChangeEvent, FormEvent, JSX, ReactNode } from "react";
import { useMemo, useState } from "react";
import type { ScheduleCadence } from "@hachi/core";
import type { ScheduleProfileOption, ScheduleWithNextFire, ScheduleWriteRequest } from "../../shared/api-types.js";
import { deleteSchedule, patchSchedule, postSchedule } from "../lib/api.js";
import { formatTimestamp } from "../lib/format.js";
import { useScheduleOptions } from "../hooks/use-schedule-options.js";
import { useSchedules } from "../hooks/use-schedules.js";
import { SelectField, type SelectOption } from "./SelectField.js";

interface ScheduleFormState {
  name: string;
  cadenceKind: ScheduleCadence;
  at: string;
  weekday: string;
  day: string;
  date: string;
  cwd: string;
  tenant: string;
  profile: string;
  prompt: string;
}

const EMPTY_FORM: ScheduleFormState = {
  name: "",
  cadenceKind: "daily",
  at: "09:00",
  weekday: "1",
  day: "1",
  date: "",
  cwd: "",
  tenant: "",
  profile: "",
  prompt: "",
};

const PROFILE_LOADING_VALUE = "__profile_loading__";
const PROFILE_DEFAULT_VALUE = "__profile_default__";
const FIELD_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent";
const MONO_FIELD_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent";
const LABEL_CLASS = "grid min-w-0 gap-1 text-xs font-semibold text-ink-muted";
const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md bg-accent-strong px-3 py-1.5 text-sm font-semibold text-on-accent transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-danger-strong/30 bg-surface px-3 py-1.5 text-xs font-medium text-danger-strong transition hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50";
const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-line text-accent-strong focus-visible:ring-2 focus-visible:ring-accent bg-surface";

const WEEKDAYS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "0", label: "日曜" },
  { value: "1", label: "月曜" },
  { value: "2", label: "火曜" },
  { value: "3", label: "水曜" },
  { value: "4", label: "木曜" },
  { value: "5", label: "金曜" },
  { value: "6", label: "土曜" },
];

function scheduleToForm(schedule: ScheduleWithNextFire): ScheduleFormState {
  return {
    name: schedule.name,
    cadenceKind: schedule.cadenceKind,
    at: `${String(schedule.atHour).padStart(2, "0")}:${String(schedule.atMinute).padStart(2, "0")}`,
    weekday: String(schedule.weekday ?? 1),
    day: String(schedule.dayOfMonth ?? 1),
    date: schedule.runDate ?? "",
    cwd: schedule.cwd,
    tenant: schedule.tenant,
    profile: schedule.profile,
    prompt: schedule.prompt,
  };
}

function parseInteger(value: string, label: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${label} は整数で入力してください`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < min || parsed > max) {
    throw new Error(`${label} は ${min}〜${max} の範囲で入力してください`);
  }
  return parsed;
}

function buildScheduleRequest(form: ScheduleFormState): ScheduleWriteRequest {
  if (!/^([0-1][0-9]|2[0-3]):([0-5][0-9])$/.test(form.at)) {
    throw new Error("時刻は HH:MM 形式で入力してください");
  }
  if (!form.cwd.startsWith("/")) {
    throw new Error("cwd は絶対パスで入力してください");
  }

  const request: ScheduleWriteRequest = {
    name: form.name.trim(),
    cadenceKind: form.cadenceKind,
    at: form.at,
    cwd: form.cwd,
    tenant: form.tenant,
    profile: form.profile,
    prompt: form.prompt,
  };

  if (request.name === "") {
    throw new Error("name は必須です");
  }
  if (request.prompt.trim() === "") {
    throw new Error("prompt は必須です");
  }

  if (form.cadenceKind === "weekly") {
    request.weekday = parseInteger(form.weekday, "weekday", 0, 6);
  }
  if (form.cadenceKind === "monthly") {
    request.day = parseInteger(form.day, "day", 1, 31);
  }
  if (form.cadenceKind === "once") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      throw new Error("date は YYYY-MM-DD 形式で入力してください");
    }
    request.date = form.date;
  }

  return request;
}

function cadenceLabel(schedule: ScheduleWithNextFire): string {
  if (schedule.cadenceKind === "weekly") {
    const weekday = WEEKDAYS.find((item) => item.value === String(schedule.weekday));
    return `weekly / ${weekday?.label ?? "-"}`;
  }
  if (schedule.cadenceKind === "monthly") {
    return `monthly / ${schedule.dayOfMonth ?? "-"}日`;
  }
  if (schedule.cadenceKind === "once") {
    return `once / ${schedule.runDate ?? "-"}`;
  }
  return "daily";
}

function profileLabel(profile: ScheduleProfileOption): string {
  return `${profile.name} (${profile.provider} / ${profile.model})${profile.isDefault ? " ※既定" : ""}`;
}

function ErrorBanner(props: { message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
      {props.message}
    </div>
  );
}

function StatusPill(props: { schedule: ScheduleWithNextFire }): JSX.Element {
  if (props.schedule.autoDisabledReason !== "") {
    return (
      <span className="inline-flex rounded-md bg-danger-soft px-2 py-1 text-xs font-semibold text-danger-strong">
        auto_disabled
      </span>
    );
  }
  return (
    <span
      className={
        props.schedule.enabled
          ? "inline-flex rounded-md bg-ok-soft px-2 py-1 text-xs font-semibold text-ok-strong"
          : "inline-flex rounded-md bg-surface-muted px-2 py-1 text-xs font-semibold text-ink-muted"
      }
    >
      {props.schedule.enabled ? "enabled" : "disabled"}
    </span>
  );
}

function MetaItem(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase text-ink-muted">{props.label}</dt>
      <dd className="mt-1 min-w-0 text-sm text-ink">{props.children}</dd>
    </div>
  );
}

function EnabledControl(props: {
  schedule: ScheduleWithNextFire;
  disabled: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <label className="inline-flex min-w-0 items-center gap-2">
      <input
        type="checkbox"
        checked={props.schedule.enabled}
        disabled={props.disabled}
        onChange={props.onToggle}
        className={CHECKBOX_CLASS}
      />
      <StatusPill schedule={props.schedule} />
    </label>
  );
}

function ScheduleActions(props: {
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={props.onEdit} className={SECONDARY_BUTTON_CLASS}>
        編集
      </button>
      <button type="button" disabled={props.disabled} onClick={props.onRemove} className={DANGER_BUTTON_CLASS}>
        削除
      </button>
    </div>
  );
}

function ScheduleMobileCard(props: {
  schedule: ScheduleWithNextFire;
  working: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}): JSX.Element {
  const { schedule } = props;
  return (
    <li className="min-w-0 rounded-md border border-line bg-surface p-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink" title={schedule.name}>
            {schedule.name}
          </h2>
          <p className="mt-1 break-all font-mono text-xs text-ink-muted">{schedule.id}</p>
        </div>
        <EnabledControl schedule={schedule} disabled={props.working} onToggle={props.onToggle} />
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MetaItem label="cadence">{cadenceLabel(schedule)}</MetaItem>
        <MetaItem label="next">
          <span className="font-mono tabular-nums">{formatTimestamp(schedule.nextFireAt)}</span>
        </MetaItem>
        <MetaItem label="last_run">
          <span className="font-mono tabular-nums">{formatTimestamp(schedule.lastRunAt)}</span>
        </MetaItem>
        <MetaItem label="failures">
          <span className="font-mono tabular-nums">{schedule.consecutiveFailures}</span>
        </MetaItem>
      </dl>

      <div className="mt-3 min-w-0 rounded-md bg-surface-muted px-2 py-1.5">
        <p className="break-all font-mono text-xs text-ink-muted">{schedule.cwd}</p>
      </div>
      {schedule.autoDisabledReason !== "" ? (
        <p className="mt-3 line-clamp-3 text-xs text-danger-strong">{schedule.autoDisabledReason}</p>
      ) : null}
      <div className="mt-3">
        <ScheduleActions
          disabled={props.working}
          onEdit={props.onEdit}
          onRemove={props.onRemove}
        />
      </div>
    </li>
  );
}

export function SchedulesView(): JSX.Element {
  const { data, error, loading, reload } = useSchedules();
  const scheduleOptions = useScheduleOptions();
  const [form, setForm] = useState<ScheduleFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);

  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  const cwdOptions = useMemo(() => scheduleOptions.data?.cwds ?? [], [scheduleOptions.data]);
  const tenantOptions = useMemo(() => scheduleOptions.data?.tenants ?? [], [scheduleOptions.data]);
  const profiles = useMemo(() => scheduleOptions.data?.profiles ?? [], [scheduleOptions.data]);
  const defaultProfile = useMemo(
    () => profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null,
    [profiles],
  );
  const profileSelectOptions = useMemo<SelectOption[]>(() => {
    if (profiles.length === 0) {
      return [
        {
          value: PROFILE_LOADING_VALUE,
          label: scheduleOptions.loading ? "読み込み中..." : "profile 未設定",
        },
      ];
    }
    const defaultDelegateOption: SelectOption = {
      value: PROFILE_DEFAULT_VALUE,
      label: `defaultProfile に委任${defaultProfile === null ? "" : ` (${defaultProfile.name})`}`,
    };
    const options = profiles.map((profile) => ({ value: profile.name, label: profileLabel(profile) }));
    if (form.profile !== "" && !profiles.some((profile) => profile.name === form.profile)) {
      return [defaultDelegateOption, { value: form.profile, label: `${form.profile} (未定義)` }, ...options];
    }
    return [defaultDelegateOption, ...options];
  }, [defaultProfile, form.profile, profiles, scheduleOptions.loading]);
  const profileSelectValue =
    profiles.length === 0
      ? PROFILE_LOADING_VALUE
      : form.profile === ""
        ? PROFILE_DEFAULT_VALUE
        : form.profile;
  const submitLabel = editingId === null ? "作成" : "保存";
  const formBusy = workingId === "form";

  function updateField<K extends keyof ScheduleFormState>(key: K, value: ScheduleFormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function onCadenceChange(event: ChangeEvent<HTMLSelectElement>): void {
    updateField("cadenceKind", event.target.value as ScheduleCadence);
  }

  function onProfileChange(value: string): void {
    if (value === PROFILE_LOADING_VALUE) {
      return;
    }
    updateField("profile", value === PROFILE_DEFAULT_VALUE ? "" : value);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setActionError(null);
    setWorkingId("form");
    try {
      const request = buildScheduleRequest(form);
      if (editingId === null) {
        await postSchedule(request);
      } else {
        await patchSchedule(editingId, request);
      }
      setForm(EMPTY_FORM);
      setEditingId(null);
      reload();
      scheduleOptions.reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingId(null);
    }
  }

  async function toggle(schedule: ScheduleWithNextFire): Promise<void> {
    setActionError(null);
    setWorkingId(schedule.id);
    try {
      await patchSchedule(schedule.id, { enabled: !schedule.enabled });
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingId(null);
    }
  }

  async function remove(schedule: ScheduleWithNextFire): Promise<void> {
    if (!window.confirm(`${schedule.name} を削除しますか?`)) {
      return;
    }
    setActionError(null);
    setWorkingId(schedule.id);
    try {
      await deleteSchedule(schedule.id);
      if (editingId === schedule.id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingId(null);
    }
  }

  function startEdit(schedule: ScheduleWithNextFire): void {
    setActionError(null);
    setEditingId(schedule.id);
    setForm(scheduleToForm(schedule));
  }

  function cancelEdit(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setActionError(null);
  }

  return (
    <main className="w-full space-y-3 px-2 py-2 sm:px-4">
      {error !== null ? <ErrorBanner message={`データ取得に失敗しました: ${error}`} /> : null}
      {scheduleOptions.error !== null ? (
        <ErrorBanner message={`入力候補の取得に失敗しました: ${scheduleOptions.error}`} />
      ) : null}
      {actionError !== null ? <ErrorBanner message={actionError} /> : null}

      <section className="min-w-0 rounded-md border border-line bg-surface p-3">
        <form className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(260px,340px)_1fr]" onSubmit={submit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
            <label className={LABEL_CLASS}>
              name
              <input
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                className={FIELD_CLASS}
              />
            </label>
            <label className={LABEL_CLASS}>
              cadence
              <select value={form.cadenceKind} onChange={onCadenceChange} className={FIELD_CLASS}>
                <option value="daily">daily</option>
                <option value="weekly">weekly</option>
                <option value="monthly">monthly</option>
                <option value="once">once</option>
              </select>
            </label>
            <label className={LABEL_CLASS}>
              at
              <input
                value={form.at}
                onChange={(event) => updateField("at", event.target.value)}
                placeholder="09:00"
                className={MONO_FIELD_CLASS}
              />
            </label>
            {form.cadenceKind === "weekly" ? (
              <label className={LABEL_CLASS}>
                weekday
                <select
                  value={form.weekday}
                  onChange={(event) => updateField("weekday", event.target.value)}
                  className={FIELD_CLASS}
                >
                  {WEEKDAYS.map((weekday) => (
                    <option key={weekday.value} value={weekday.value}>
                      {weekday.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {form.cadenceKind === "monthly" ? (
              <label className={LABEL_CLASS}>
                day
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={form.day}
                  onChange={(event) => updateField("day", event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
            ) : null}
            {form.cadenceKind === "once" ? (
              <label className={LABEL_CLASS}>
                date
                <input
                  type="date"
                  value={form.date}
                  onChange={(event) => updateField("date", event.target.value)}
                  className={FIELD_CLASS}
                />
              </label>
            ) : null}
          </div>

          <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-3">
            <label className={`${LABEL_CLASS} order-1 md:col-span-3`}>
              cwd
              <input
                value={form.cwd}
                onChange={(event) => updateField("cwd", event.target.value)}
                list="schedule-cwd-options"
                placeholder="/tmp/hk-scheduler"
                className={MONO_FIELD_CLASS}
              />
              <datalist id="schedule-cwd-options">
                {cwdOptions.map((cwd) => (
                  <option key={cwd} value={cwd} />
                ))}
              </datalist>
            </label>
            <label className={`${LABEL_CLASS} order-2`}>
              tenant
              <input
                value={form.tenant}
                onChange={(event) => updateField("tenant", event.target.value)}
                list="schedule-tenant-options"
                placeholder="dev"
                className={FIELD_CLASS}
              />
              <datalist id="schedule-tenant-options">
                {tenantOptions.map((tenant) => (
                  <option key={tenant} value={tenant} />
                ))}
              </datalist>
            </label>
            <div className="order-3 min-w-0">
              <SelectField
                label="profile"
                value={profileSelectValue}
                options={profileSelectOptions}
                onValueChange={onProfileChange}
              />
            </div>
            <label className={`${LABEL_CLASS} order-4 md:order-5 md:col-span-3`}>
              prompt
              <textarea
                value={form.prompt}
                onChange={(event) => updateField("prompt", event.target.value)}
                rows={5}
                className="min-h-32 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
              />
            </label>
            <div className="order-5 flex flex-col items-stretch gap-2 sm:flex-row sm:items-end md:order-4">
              <button type="submit" disabled={formBusy} className={PRIMARY_BUTTON_CLASS}>
                {submitLabel}
              </button>
              {editingId !== null ? (
                <button type="button" onClick={cancelEdit} className={SECONDARY_BUTTON_CLASS}>
                  取消
                </button>
              ) : null}
            </div>
          </div>
        </form>
      </section>

      <section className="min-w-0">
        <div className="lg:hidden">
          {loading && schedules.length === 0 ? (
            <p className="rounded-md border border-line bg-surface px-3 py-8 text-sm text-ink-muted">
              読み込み中...
            </p>
          ) : schedules.length === 0 ? (
            <p className="rounded-md border border-line bg-surface px-3 py-8 text-sm text-ink-muted">
              スケジュールはありません
            </p>
          ) : (
            <ul className="space-y-2">
              {schedules.map((schedule) => (
                <ScheduleMobileCard
                  key={schedule.id}
                  schedule={schedule}
                  working={workingId === schedule.id}
                  onToggle={() => void toggle(schedule)}
                  onEdit={() => startEdit(schedule)}
                  onRemove={() => void remove(schedule)}
                />
              ))}
            </ul>
          )}
        </div>

        <div className="hidden overflow-hidden rounded-md border border-line bg-surface lg:block">
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
              <thead className="border-b border-line bg-surface-muted text-xs uppercase text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">name</th>
                  <th className="px-3 py-2 font-semibold">cadence</th>
                  <th className="px-3 py-2 font-semibold">次回発火(JST)</th>
                  <th className="px-3 py-2 font-semibold">enabled</th>
                  <th className="px-3 py-2 font-semibold">last_run</th>
                  <th className="px-3 py-2 font-semibold">連続失敗</th>
                  <th className="px-3 py-2 font-semibold">auto_disabled</th>
                  <th className="px-3 py-2 font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {loading && schedules.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                      読み込み中...
                    </td>
                  </tr>
                ) : schedules.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                      スケジュールはありません
                    </td>
                  </tr>
                ) : (
                  schedules.map((schedule) => (
                    <tr key={schedule.id} className="align-top transition hover:bg-surface-muted">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-ink">{schedule.name}</div>
                        <div className="font-mono text-xs text-ink-muted">{schedule.id}</div>
                        <div className="mt-1 max-w-[320px] truncate font-mono text-xs text-ink-muted">
                          {schedule.cwd}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-ink">{cadenceLabel(schedule)}</td>
                      <td className="px-3 py-2 font-mono tabular-nums text-ink">
                        {formatTimestamp(schedule.nextFireAt)}
                      </td>
                      <td className="px-3 py-2">
                        <EnabledControl
                          schedule={schedule}
                          disabled={workingId === schedule.id}
                          onToggle={() => void toggle(schedule)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums text-ink">
                        {formatTimestamp(schedule.lastRunAt)}
                      </td>
                      <td className="px-3 py-2 font-mono tabular-nums text-ink">
                        {schedule.consecutiveFailures}
                      </td>
                      <td className="px-3 py-2 text-ink">
                        <span className="line-clamp-2 max-w-[260px]">
                          {schedule.autoDisabledReason === "" ? "-" : schedule.autoDisabledReason}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <ScheduleActions
                          disabled={workingId === schedule.id}
                          onEdit={() => startEdit(schedule)}
                          onRemove={() => void remove(schedule)}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}
