// =============================================================================
// 設定編集画面（docs/contract.md §45）。config.json を完全形 JSON として扱い、
// フォーム編集と Raw JSON 編集を同一 state の双方向ビューにする。
// =============================================================================

import type { ChangeEvent, FormEvent, JSX, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { hachiConfigSchema } from "@hachi/core/config-schema";
import { ApiError, fetchConfig, putConfig } from "../lib/api.js";

type SettingsTab = "form" | "raw";
type ProviderValue = "codex" | "claude";
type TransportFormValue = "" | "bridge" | "direct";
type EffortFormValue = "" | "low" | "medium" | "high" | "xhigh" | "max";

interface ConfigObject {
  [key: string]: unknown;
}

interface ProfileFormRow {
  name: string;
  provider: ProviderValue;
  model: string;
  transport: TransportFormValue;
  effort: EffortFormValue;
  raw: ConfigObject;
}

interface TenantFormRow {
  key: string;
  value: string;
}

interface ValidationIssue {
  path: string;
  message: string;
}

const FIELD_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent";
const MONO_FIELD_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-1.5 font-mono text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent";
const LABEL_CLASS = "grid min-w-0 gap-1 text-xs font-semibold text-ink-muted";
const TEXTAREA_CLASS =
  "min-h-40 w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent";
const SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md bg-accent-strong px-3 py-1.5 text-sm font-semibold text-on-accent transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON_CLASS =
  "inline-flex min-h-9 items-center justify-center rounded-md border border-danger-strong/30 bg-surface px-3 py-1.5 text-xs font-medium text-danger-strong transition hover:bg-danger-soft disabled:cursor-not-allowed disabled:opacity-50";
const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-line bg-surface text-accent-strong focus-visible:ring-2 focus-visible:ring-accent";

const NEW_CONFIG_TEMPLATE: ConfigObject = {
  profiles: {
    implement: {
      provider: "codex",
      model: "gpt-5.6-luna",
      transport: "direct",
      effort: "max",
      speed: "standard",
    },
    review: { provider: "codex", model: "gpt-5.6-sol", effort: "high" },
    docs: { provider: "codex", model: "gpt-5.6-luna", effort: "high" },
  },
  allowlist: {
    codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
  },
  resourceGuard: {
    maxInFlight: 10,
    maxLaunchesPerTick: 2,
  },
  defaultProfile: "implement",
  verify: { tenants: {} },
  notify: { transports: [], telegram: {} },
  steward: {},
  review: {},
  dispatch: { providerLaunchLimits: {} },
};

function isConfigObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfigObject(config: ConfigObject): ConfigObject {
  const cloned = JSON.parse(JSON.stringify(config)) as unknown;
  return isConfigObject(cloned) ? cloned : {};
}

function cloneRecord(value: unknown): ConfigObject {
  return isConfigObject(value) ? { ...value } : {};
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function parseRawConfig(text: string): ConfigObject {
  const parsed = JSON.parse(text) as unknown;
  if (!isConfigObject(parsed)) {
    throw new Error("config は JSON object が必須です");
  }
  return parsed;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberInputValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function providerValue(value: unknown): ProviderValue {
  return value === "claude" ? "claude" : "codex";
}

function transportValue(value: unknown): TransportFormValue {
  if (value === "bridge" || value === "direct") {
    return value;
  }
  return "";
}

function effortValue(value: unknown): EffortFormValue {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
    return value;
  }
  return "";
}

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((part) => String(part)).join(".");
}

function collectValidationIssues(config: ConfigObject): ValidationIssue[] {
  const result = hachiConfigSchema.safeParse(config);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => ({
    path: issuePath(issue.path),
    message: issue.message,
  }));
}

function messagesForPrefix(issues: readonly ValidationIssue[], prefix: string): string[] {
  return issues
    .filter((issue) => issue.path === prefix || issue.path.startsWith(`${prefix}.`))
    .map((issue) => `${issue.path}: ${issue.message}`);
}

function firstMessageForPrefix(issues: readonly ValidationIssue[], prefix: string): string | null {
  return messagesForPrefix(issues, prefix)[0] ?? null;
}

function getSection(config: ConfigObject, key: string): ConfigObject {
  return cloneRecord(config[key]);
}

function setSection(config: ConfigObject, key: string, section: ConfigObject): ConfigObject {
  const next = cloneConfigObject(config);
  next[key] = section;
  return next;
}

function setTopLevelValue(config: ConfigObject, key: string, value: unknown): ConfigObject {
  const next = cloneConfigObject(config);
  next[key] = value;
  return next;
}

function setNumericField(section: ConfigObject, key: string, raw: string, required: boolean): ConfigObject {
  const next = { ...section };
  if (raw.trim() === "") {
    if (required) {
      next[key] = "";
    } else {
      delete next[key];
    }
    return next;
  }
  next[key] = Number(raw);
  return next;
}

function profileRows(config: ConfigObject): ProfileFormRow[] {
  const profiles = getSection(config, "profiles");
  return Object.entries(profiles).map(([name, value]) => {
    const raw = cloneRecord(value);
    return {
      name,
      provider: providerValue(raw.provider),
      model: stringValue(raw.model),
      transport: transportValue(raw.transport),
      effort: effortValue(raw.effort),
      raw,
    };
  });
}

function profileToConfig(row: ProfileFormRow): ConfigObject {
  const next = { ...row.raw };
  next.provider = row.provider;
  next.model = row.model;
  if (row.transport === "") {
    delete next.transport;
  } else {
    next.transport = row.transport;
  }
  if (row.effort === "") {
    delete next.effort;
  } else {
    next.effort = row.effort;
  }
  return next;
}

function uniqueProfileName(config: ConfigObject): string {
  const profiles = getSection(config, "profiles");
  let index = 1;
  while (Object.prototype.hasOwnProperty.call(profiles, `profile${index}`)) {
    index += 1;
  }
  return `profile${index}`;
}

function tenantRows(config: ConfigObject): TenantFormRow[] {
  const verify = getSection(config, "verify");
  const tenants = getSection(verify, "tenants");
  return Object.entries(tenants).map(([key, value]) => ({ key, value: stringValue(value) }));
}

function updateTenantRows(config: ConfigObject, rows: readonly TenantFormRow[]): ConfigObject {
  const verify = getSection(config, "verify");
  const tenants: ConfigObject = {};
  for (const row of rows) {
    tenants[row.key] = row.value;
  }
  verify.tenants = tenants;
  return setSection(config, "verify", verify);
}

function setNestedSection(config: ConfigObject, parentKey: string, childKey: string, section: ConfigObject): ConfigObject {
  const parent = getSection(config, parentKey);
  parent[childKey] = section;
  return setSection(config, parentKey, parent);
}

function ErrorBanner(props: { message: string; issues?: readonly string[] }): JSX.Element {
  const issues = props.issues ?? [];
  return (
    <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
      <p>{props.message}</p>
      {issues.length > 0 ? (
        <ul data-testid="settings-error-issues" className="mt-1 list-inside list-disc space-y-0.5">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function InfoBanner(props: { message: string }): JSX.Element {
  return (
    <div className="rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-sm text-accent-strong">
      {props.message}
    </div>
  );
}

function WarningBanner(props: { onReload: () => void }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn-strong/30 bg-warn-soft px-3 py-2 text-sm text-warn-strong">
      <span>同時更新を検知しました。</span>
      <button type="button" onClick={props.onReload} className={SECONDARY_BUTTON_CLASS}>
        再読込
      </button>
    </div>
  );
}

function Section(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-md border border-line bg-surface p-3">
      <h2 className="mb-3 text-sm font-semibold text-ink">{props.title}</h2>
      {props.children}
    </section>
  );
}

function FieldIssue(props: { message: string | null }): JSX.Element | null {
  if (props.message === null) {
    return null;
  }
  return <p className="text-xs font-normal text-danger-strong">{props.message}</p>;
}

function TabButton(props: {
  active: boolean;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`min-h-9 rounded-md px-3 text-sm font-medium transition ${
        props.active ? "bg-accent-strong text-on-accent" : "text-ink-muted hover:bg-surface-muted hover:text-ink"
      }`}
    >
      {props.label}
    </button>
  );
}

export function SettingsView(): JSX.Element {
  const [tab, setTab] = useState<SettingsTab>("form");
  const [config, setConfig] = useState<ConfigObject>(() => cloneConfigObject(NEW_CONFIG_TEMPLATE));
  const [rawText, setRawText] = useState<string>(() => formatJson(NEW_CONFIG_TEMPLATE));
  const [rawError, setRawError] = useState<string | null>(null);
  const [baseEtag, setBaseEtag] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorIssues, setErrorIssues] = useState<string[]>([]);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState<boolean>(false);

  const validationIssues = useMemo<ValidationIssue[]>(() => collectValidationIssues(config), [config]);
  const profiles = useMemo<ProfileFormRow[]>(() => profileRows(config), [config]);
  const tenants = useMemo<TenantFormRow[]>(() => tenantRows(config), [config]);
  const allowlist = getSection(config, "allowlist");
  const resourceGuard = getSection(config, "resourceGuard");
  const notify = getSection(config, "notify");
  const telegram = getSection(notify, "telegram");
  const steward = getSection(config, "steward");
  const review = getSection(config, "review");
  const dispatch = getSection(config, "dispatch");
  const providerLaunchLimits = getSection(dispatch, "providerLaunchLimits");
  const transports = stringArray(notify.transports);

  function commitConfig(next: ConfigObject): void {
    setConfig(next);
    setRawText(formatJson(next));
    setRawError(null);
    setSuccessMessage(null);
    setConflict(false);
  }

  function loadConfig(): void {
    setLoading(true);
    setError(null);
    setErrorIssues([]);
    const controller = new AbortController();
    fetchConfig(controller.signal)
      .then((response) => {
        const nextConfig =
          response.config === null
            ? cloneConfigObject(NEW_CONFIG_TEMPLATE)
            : parseRawConfig(formatJson(response.config));
        setConfig(nextConfig);
        setRawText(formatJson(nextConfig));
        setRawError(null);
        setBaseEtag(response.etag);
        setExists(response.exists);
        setConflict(false);
        setSuccessMessage(response.exists ? null : "config.json は未作成です。");
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setErrorIssues([]);
        setLoading(false);
      });
  }

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setErrorIssues([]);
    const controller = new AbortController();
    fetchConfig(controller.signal)
      .then((response) => {
        if (disposed) {
          return;
        }
        const nextConfig =
          response.config === null
            ? cloneConfigObject(NEW_CONFIG_TEMPLATE)
            : parseRawConfig(formatJson(response.config));
        setConfig(nextConfig);
        setRawText(formatJson(nextConfig));
        setRawError(null);
        setBaseEtag(response.etag);
        setExists(response.exists);
        setSuccessMessage(response.exists ? null : "config.json は未作成です。");
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (disposed || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setErrorIssues([]);
        setLoading(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, []);

  function onRawChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    const nextText = event.currentTarget.value;
    setRawText(nextText);
    setSuccessMessage(null);
    setConflict(false);
    try {
      const nextConfig = parseRawConfig(nextText);
      setConfig(nextConfig);
      setRawError(null);
    } catch (err: unknown) {
      setRawError(err instanceof Error ? err.message : String(err));
    }
  }

  function updateProfile(oldName: string, patch: Partial<ProfileFormRow>): void {
    const current = profiles.find((profile) => profile.name === oldName);
    if (current === undefined) {
      return;
    }
    const updated: ProfileFormRow = { ...current, ...patch };
    const nextProfiles = getSection(config, "profiles");
    delete nextProfiles[oldName];
    nextProfiles[updated.name] = profileToConfig(updated);
    commitConfig(setSection(config, "profiles", nextProfiles));
  }

  function addProfile(): void {
    const name = uniqueProfileName(config);
    const nextProfiles = getSection(config, "profiles");
    nextProfiles[name] = { provider: "codex", model: "" };
    commitConfig(setSection(config, "profiles", nextProfiles));
  }

  function removeProfile(name: string): void {
    const nextProfiles = getSection(config, "profiles");
    delete nextProfiles[name];
    commitConfig(setSection(config, "profiles", nextProfiles));
  }

  function updateResourceGuard(key: string, raw: string, required: boolean): void {
    commitConfig(setSection(config, "resourceGuard", setNumericField(resourceGuard, key, raw, required)));
  }

  function updateAllowlist(provider: ProviderValue, raw: string): void {
    const nextAllowlist = { ...allowlist };
    nextAllowlist[provider] = raw.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    commitConfig(setSection(config, "allowlist", nextAllowlist));
  }

  function updateNotifyTransport(transport: string, enabled: boolean): void {
    const existing = stringArray(notify.transports);
    const nextTransports = enabled
      ? [...new Set([...existing, transport])]
      : existing.filter((item) => item !== transport);
    const nextNotify = { ...notify, transports: nextTransports };
    commitConfig(setSection(config, "notify", nextNotify));
  }

  function updateTelegramString(key: string, value: string): void {
    const nextTelegram = { ...telegram };
    if (value.trim() === "") {
      delete nextTelegram[key];
    } else {
      nextTelegram[key] = value;
    }
    commitConfig(setNestedSection(config, "notify", "telegram", nextTelegram));
  }

  function updateTelegramPriority(value: string): void {
    commitConfig(setNestedSection(config, "notify", "telegram", setNumericField(telegram, "minPriority", value, false)));
  }

  function updateStewardInterval(value: string): void {
    commitConfig(setSection(config, "steward", setNumericField(steward, "intervalMinutes", value, false)));
  }

  function updateReviewMaxRework(value: string): void {
    commitConfig(setSection(config, "review", setNumericField(review, "maxReworkLaunches", value, false)));
  }

  function updateProviderLimit(provider: ProviderValue, value: string): void {
    const nextLimits = setNumericField(providerLaunchLimits, provider, value, false);
    commitConfig(setNestedSection(config, "dispatch", "providerLaunchLimits", nextLimits));
  }

  function updateTenant(index: number, patch: Partial<TenantFormRow>): void {
    const nextRows = tenants.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    commitConfig(updateTenantRows(config, nextRows));
  }

  function addTenant(): void {
    commitConfig(updateTenantRows(config, [...tenants, { key: "tenant", value: "pnpm test" }]));
  }

  function removeTenant(index: number): void {
    commitConfig(updateTenantRows(config, tenants.filter((_, rowIndex) => rowIndex !== index)));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setErrorIssues([]);
    setSuccessMessage(null);
    setConflict(false);
    if (rawError !== null) {
      setError(rawError);
      return;
    }
    const parsed = hachiConfigSchema.safeParse(config);
    if (!parsed.success) {
      // 送信前検証（zod）の失敗は、どのフィールドが何故落ちたかを issue 単位で出す。
      const issues = parsed.error.issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`);
      setError(`config.json の検証に失敗しました（${issues.length}件）`);
      setErrorIssues(issues);
      return;
    }
    setSaving(true);
    try {
      const response = await putConfig({ config, baseEtag });
      setBaseEtag(response.etag);
      setExists(true);
      setSuccessMessage("保存しました。次 tick から適用されます。");
      setErrorIssues([]);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict(true);
        setError(null);
        setErrorIssues([]);
      } else if (err instanceof ApiError && err.issues !== undefined && err.issues.length > 0) {
        // サーバの allowlist/semantics 違反理由（issues）をそのまま出す。
        setError(err.message);
        setErrorIssues([...err.issues]);
      } else {
        // 401 を含む issues の無いエラーは従来どおり message だけ表示する。
        setError(err instanceof Error ? err.message : String(err));
        setErrorIssues([]);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="w-full space-y-3 px-2 py-2 sm:px-4">
      {loading ? (
        <InfoBanner message="読み込み中..." />
      ) : null}
      {error !== null ? <ErrorBanner message={error} issues={errorIssues} /> : null}
      {successMessage !== null ? <InfoBanner message={successMessage} /> : null}
      {conflict ? <WarningBanner onReload={loadConfig} /> : null}

      <form className="space-y-3" onSubmit={(event) => void submit(event)}>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface p-2">
          <div className="flex gap-1">
            <TabButton active={tab === "form"} label="フォーム" onClick={() => setTab("form")} />
            <TabButton active={tab === "raw"} label="Raw JSON" onClick={() => setTab("raw")} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-ink-muted">
              {exists ? `etag ${baseEtag ?? "-"}` : "new config"}
            </span>
            <button type="button" onClick={loadConfig} className={SECONDARY_BUTTON_CLASS}>
              再読込
            </button>
            <button type="submit" disabled={saving || loading} className={PRIMARY_BUTTON_CLASS}>
              保存
            </button>
          </div>
        </div>

        {validationIssues.length > 0 ? (
          <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
            <p className="font-semibold">validation</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5">
              {validationIssues.slice(0, 8).map((issue) => (
                <li key={`${issue.path}-${issue.message}`}>
                  {issue.path}: {issue.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {tab === "raw" ? (
          <Section title="Raw JSON">
            <textarea
              data-testid="settings-raw-json"
              value={rawText}
              onChange={onRawChange}
              spellCheck={false}
              className="min-h-[70vh] w-full min-w-0 rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
            />
            {rawError !== null ? <p className="mt-2 text-sm text-danger-strong">{rawError}</p> : null}
          </Section>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
            <div className="space-y-3">
              <Section title="profiles">
                <div className="space-y-2">
                  {profiles.map((profile) => (
                    <div
                      key={profile.name}
                      className="grid grid-cols-1 gap-2 rounded-md border border-line bg-surface-muted p-2 lg:grid-cols-[minmax(120px,1fr)_120px_minmax(160px,1.4fr)_120px_120px_auto]"
                    >
                      <label className={LABEL_CLASS}>
                        name
                        <input
                          value={profile.name}
                          onChange={(event) => updateProfile(profile.name, { name: event.currentTarget.value })}
                          className={MONO_FIELD_CLASS}
                        />
                      </label>
                      <label className={LABEL_CLASS}>
                        provider
                        <select
                          value={profile.provider}
                          onChange={(event) =>
                            updateProfile(profile.name, { provider: event.currentTarget.value as ProviderValue })
                          }
                          className={FIELD_CLASS}
                        >
                          <option value="codex">codex</option>
                          <option value="claude">claude</option>
                        </select>
                      </label>
                      <label className={LABEL_CLASS}>
                        model
                        <input
                          data-testid={`settings-profile-model-${profile.name}`}
                          list={`settings-model-options-${profile.provider}`}
                          value={profile.model}
                          onChange={(event) => updateProfile(profile.name, { model: event.currentTarget.value })}
                          className={MONO_FIELD_CLASS}
                        />
                        <FieldIssue message={firstMessageForPrefix(validationIssues, `profiles.${profile.name}.model`)} />
                      </label>
                      <label className={LABEL_CLASS}>
                        transport
                        <select
                          value={profile.transport}
                          onChange={(event) =>
                            updateProfile(profile.name, {
                              transport: event.currentTarget.value as TransportFormValue,
                            })
                          }
                          className={FIELD_CLASS}
                        >
                          <option value="">default</option>
                          <option value="bridge">bridge</option>
                          <option value="direct">direct</option>
                        </select>
                      </label>
                      <label className={LABEL_CLASS}>
                        effort
                        <select
                          data-testid={`settings-profile-effort-${profile.name}`}
                          value={profile.effort}
                          onChange={(event) =>
                            updateProfile(profile.name, { effort: event.currentTarget.value as EffortFormValue })
                          }
                          className={FIELD_CLASS}
                        >
                          <option value="">default</option>
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                          <option value="xhigh">xhigh</option>
                          <option value="max">max</option>
                        </select>
                      </label>
                      <div className="flex items-end">
                        <button type="button" onClick={() => removeProfile(profile.name)} className={DANGER_BUTTON_CLASS}>
                          削除
                        </button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addProfile} className={SECONDARY_BUTTON_CLASS}>
                    追加
                  </button>
                  {(["codex", "claude"] as const).map((provider) => (
                    <datalist id={`settings-model-options-${provider}`} key={provider}>
                      {stringArray(allowlist[provider]).map((model) => (
                        <option value={model} key={model} />
                      ))}
                    </datalist>
                  ))}
                </div>
              </Section>

              <Section title="verify.tenants">
                <div className="space-y-2">
                  {tenants.map((tenant, index) => (
                    <div key={`${tenant.key}-${index}`} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <label className={LABEL_CLASS}>
                        tenant
                        <input
                          value={tenant.key}
                          onChange={(event) => updateTenant(index, { key: event.currentTarget.value })}
                          className={MONO_FIELD_CLASS}
                        />
                      </label>
                      <label className={LABEL_CLASS}>
                        command
                        <input
                          value={tenant.value}
                          onChange={(event) => updateTenant(index, { value: event.currentTarget.value })}
                          className={MONO_FIELD_CLASS}
                        />
                      </label>
                      <div className="flex items-end">
                        <button type="button" onClick={() => removeTenant(index)} className={DANGER_BUTTON_CLASS}>
                          削除
                        </button>
                      </div>
                    </div>
                  ))}
                  <button type="button" onClick={addTenant} className={SECONDARY_BUTTON_CLASS}>
                    追加
                  </button>
                </div>
              </Section>

              <Section title="notify">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-ink">
                    <input
                      type="checkbox"
                      checked={transports.includes("telegram")}
                      onChange={(event) => updateNotifyTransport("telegram", event.currentTarget.checked)}
                      className={CHECKBOX_CLASS}
                    />
                    telegram
                  </label>
                  <label className={LABEL_CLASS}>
                    minPriority
                    <input
                      type="number"
                      value={numberInputValue(telegram.minPriority)}
                      onChange={(event) => updateTelegramPriority(event.currentTarget.value)}
                      className={FIELD_CLASS}
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    chatId
                    <input
                      value={stringValue(telegram.chatId)}
                      onChange={(event) => updateTelegramString("chatId", event.currentTarget.value)}
                      className={MONO_FIELD_CLASS}
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    baseUrl
                    <input
                      value={stringValue(telegram.baseUrl)}
                      onChange={(event) => updateTelegramString("baseUrl", event.currentTarget.value)}
                      className={MONO_FIELD_CLASS}
                    />
                  </label>
                </div>
              </Section>
            </div>

            <div className="space-y-3">
              <Section title="core">
                <div className="space-y-3">
                  <label className={LABEL_CLASS}>
                    defaultProfile
                    <input
                      value={stringValue(config.defaultProfile)}
                      onChange={(event) => commitConfig(setTopLevelValue(config, "defaultProfile", event.currentTarget.value))}
                      className={MONO_FIELD_CLASS}
                    />
                    <FieldIssue message={firstMessageForPrefix(validationIssues, "defaultProfile")} />
                  </label>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className={LABEL_CLASS}>
                      maxInFlight
                      <input
                        type="number"
                        value={numberInputValue(resourceGuard.maxInFlight)}
                        onChange={(event) => updateResourceGuard("maxInFlight", event.currentTarget.value, true)}
                        className={FIELD_CLASS}
                      />
                    </label>
                    <label className={LABEL_CLASS}>
                      maxLaunchesPerTick
                      <input
                        type="number"
                        value={numberInputValue(resourceGuard.maxLaunchesPerTick)}
                        onChange={(event) =>
                          updateResourceGuard("maxLaunchesPerTick", event.currentTarget.value, true)
                        }
                        className={FIELD_CLASS}
                      />
                    </label>
                    <label className={LABEL_CLASS}>
                      maxRunSeconds
                      <input
                        type="number"
                        value={numberInputValue(resourceGuard.maxRunSeconds)}
                        onChange={(event) => updateResourceGuard("maxRunSeconds", event.currentTarget.value, false)}
                        className={FIELD_CLASS}
                      />
                    </label>
                  </div>
                  <label className={LABEL_CLASS}>
                    allowlist.codex
                    <textarea
                      value={stringArray(allowlist.codex).join("\n")}
                      onChange={(event) => updateAllowlist("codex", event.currentTarget.value)}
                      className={TEXTAREA_CLASS}
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    allowlist.claude
                    <textarea
                      value={stringArray(allowlist.claude).join("\n")}
                      onChange={(event) => updateAllowlist("claude", event.currentTarget.value)}
                      className={TEXTAREA_CLASS}
                    />
                  </label>
                </div>
              </Section>

              <Section title="steward">
                <label className={LABEL_CLASS}>
                  intervalMinutes
                  <input
                    type="number"
                    data-testid="settings-steward-interval"
                    value={numberInputValue(steward.intervalMinutes)}
                    onChange={(event) => updateStewardInterval(event.currentTarget.value)}
                    className={FIELD_CLASS}
                  />
                </label>
              </Section>

              <Section title="review">
                <label className={LABEL_CLASS}>
                  maxReworkLaunches
                  <input
                    type="number"
                    min="1"
                    max="1"
                    data-testid="settings-review-max-rework"
                    value={numberInputValue(review.maxReworkLaunches)}
                    onChange={(event) => updateReviewMaxRework(event.currentTarget.value)}
                    className={FIELD_CLASS}
                  />
                </label>
              </Section>

              <Section title="dispatch.providerLaunchLimits">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className={LABEL_CLASS}>
                    codex
                    <input
                      type="number"
                      value={numberInputValue(providerLaunchLimits.codex)}
                      onChange={(event) => updateProviderLimit("codex", event.currentTarget.value)}
                      className={FIELD_CLASS}
                    />
                  </label>
                  <label className={LABEL_CLASS}>
                    claude
                    <input
                      type="number"
                      value={numberInputValue(providerLaunchLimits.claude)}
                      onChange={(event) => updateProviderLimit("claude", event.currentTarget.value)}
                      className={FIELD_CLASS}
                    />
                  </label>
                </div>
              </Section>
            </div>
          </div>
        )}
      </form>
    </main>
  );
}
