// =============================================================================
// 全画面共通 AppShell。48px の単一行ヘッダーにパンくず・検索/絞り込み・主要ナビを集約する
// （docs/contract.md §37.2）。
// =============================================================================

import type { JSX, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useRunningSessions } from "../hooks/use-running-sessions.js";
import type { Route } from "../hooks/use-navigation.js";
import { DISPLAY_BUCKETS, type DisplayBucket } from "../lib/constants.js";
import { useActiveWorkerCountTitle } from "../lib/document-title.js";
import {
  BookIcon,
  CalendarIcon,
  FilterIcon,
  MetricsIcon,
  UsageIcon,
  MoreIcon,
  SearchIcon,
  SessionsIcon,
  SettingsIcon,
} from "./icons.js";
import { SelectField } from "./SelectField.js";
import { SupervisorPanel, type SupervisorCounts } from "./SupervisorPanel.js";
import { useTheme } from "../hooks/use-theme.js";
import { countActiveFilters } from "./Toolbar.js";

const ALL_TENANT_VALUE = "__all_tenants__";

// タブ非表示中も実行中ワーカー数をタイトルに反映するための低頻度ポーリング間隔
// （docs/contract.md §37.7）。表示中は use-running-sessions の通常間隔が担当する。
const HIDDEN_POLL_INTERVAL_MS = 30_000;

interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface HeaderNavItem {
  label: string;
  path: string;
  active: boolean;
  icon: JSX.Element;
}

export interface AppShellBoardControls {
  tenants: string[];
  tenant: string;
  bucket: DisplayBucket;
  watchedOnly: boolean;
  query: string;
  onTenantChange: (tenant: string) => void;
  onBucketChange: (bucket: DisplayBucket) => void;
  onWatchedOnlyChange: (watchedOnly: boolean) => void;
  onQueryChange: (query: string) => void;
}

export interface AppShellProps {
  route: Route;
  boardControls: AppShellBoardControls;
  boardCounts: SupervisorCounts | null;
  children: ReactNode;
  headerHumanDecisions?: ReactNode;
  onNavigate: (path: string) => void;
}

function shortValue(value: string): string {
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 10)}...${value.slice(-5)}`;
}

function breadcrumbsForRoute(route: Route): BreadcrumbItem[] {
  switch (route.name) {
    case "task":
      return [
        { label: "board", path: "/" },
        { label: shortValue(route.taskId) },
      ];
    case "sessions":
      return [{ label: "sessions" }];
    case "session":
      return [
        { label: "sessions", path: "/sessions" },
        { label: shortValue(route.sessionId) },
      ];
    case "schedules":
      return [{ label: "schedules" }];
    case "knowledge":
      return [{ label: "knowledge" }];
    case "metrics":
      return [{ label: "metrics" }];
    case "usage":
      return [{ label: "usage" }];
    case "settings":
      return [{ label: "settings" }];
    case "board":
      return [{ label: "board" }];
  }
}

function HeaderIconButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: JSX.Element;
  badge?: number;
}): JSX.Element {
  const activeClass = props.active
    ? "border-accent/30 bg-accent-soft text-accent-strong"
    : "border-line bg-surface text-ink-muted hover:bg-surface-muted";

  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className={`relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition ${activeClass}`}
    >
      {props.children}
      {props.badge !== undefined && props.badge > 0 ? (
        <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent-strong px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">
          {props.badge}
        </span>
      ) : null}
    </button>
  );
}

function HeaderMenuButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: JSX.Element;
}): JSX.Element {
  const activeClass = props.active
    ? "border-accent/30 bg-accent-soft text-accent-strong"
    : "border-line bg-surface text-ink hover:bg-surface-muted";

  return (
    <button
      type="button"
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
      className={`flex min-h-10 w-full items-center gap-2 rounded-md border px-3 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-accent ${activeClass}`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
        {props.children}
      </span>
      <span>{props.label}</span>
    </button>
  );
}

function SearchInput(props: { controls: AppShellBoardControls; className: string }): JSX.Element {
  return (
    <input
      type="search"
      value={props.controls.query}
      onChange={(event) => props.controls.onQueryChange(event.target.value)}
      placeholder="検索"
      aria-label="検索（title / ID）"
      className={`h-9 min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-muted hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent ${props.className}`}
    />
  );
}

function FilterFields(props: {
  controls: AppShellBoardControls;
  includeSearch: boolean;
  onClear: () => void;
}): JSX.Element {
  const tenantOptions = [
    { value: ALL_TENANT_VALUE, label: "全て" },
    ...props.controls.tenants.map((tenant) => ({ value: tenant, label: tenant })),
  ];

  return (
    <div className="flex flex-col gap-3">
      {props.includeSearch ? <SearchInput controls={props.controls} className="w-full" /> : null}
      <SelectField
        label="tenant"
        value={props.controls.tenant === "" ? ALL_TENANT_VALUE : props.controls.tenant}
        options={tenantOptions}
        onValueChange={(value) => props.controls.onTenantChange(value === ALL_TENANT_VALUE ? "" : value)}
      />
      <SelectField
        label="表示バケット"
        value={props.controls.bucket}
        options={DISPLAY_BUCKETS}
        onValueChange={(value) => props.controls.onBucketChange(value as DisplayBucket)}
      />
      <label className="flex min-h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink transition hover:bg-surface-muted">
        <input
          type="checkbox"
          checked={props.controls.watchedOnly}
          onChange={(event) => props.controls.onWatchedOnlyChange(event.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        ウォッチ中のみ
      </label>
      <button
        type="button"
        onClick={props.onClear}
        data-testid="appshell-clear-filters"
        className="inline-flex min-h-10 items-center justify-center rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
      >
        クリア
      </button>
    </div>
  );
}

export function AppShell(props: AppShellProps): JSX.Element {
  const [mobileSearchOpen, setMobileSearchOpen] = useState<boolean>(false);
  const [filterOpen, setFilterOpen] = useState<boolean>(false);
  const [moreNavOpen, setMoreNavOpen] = useState<boolean>(false);
  const moreNavTriggerRef = useRef<HTMLButtonElement>(null);
  const transferringFocus = useRef<boolean>(false);
  const { preference, setPreference } = useTheme();
  const sessions = useRunningSessions("running", { hiddenIntervalMs: HIDDEN_POLL_INTERVAL_MS });
  const sessionCount = sessions.data?.sessions.length ?? 0;
  // 実行中ワーカー数を document.title の先頭へ出す（docs/contract.md §37.7）。
  useActiveWorkerCountTitle(sessionCount);
  const breadcrumbs = breadcrumbsForRoute(props.route);
  const activeFilterCount = countActiveFilters({
    tenant: props.boardControls.tenant,
    bucket: props.boardControls.bucket,
    watchedOnly: props.boardControls.watchedOnly,
    query: props.boardControls.query,
  });
  const rootClass =
    props.route.name === "session"
      ? "flex h-screen flex-col overflow-hidden bg-canvas transition-colors"
      : "min-h-screen bg-canvas transition-colors";

  const clearFilters = (): void => {
    props.boardControls.onTenantChange("");
    props.boardControls.onBucketChange("all");
    props.boardControls.onWatchedOnlyChange(false);
    props.boardControls.onQueryChange("");
    setMobileSearchOpen(false);
    setFilterOpen(false);
  };
  const secondaryNavItems: HeaderNavItem[] = [
    {
      label: "メトリクス",
      path: "/metrics",
      active: props.route.name === "metrics",
      icon: <MetricsIcon className="h-4 w-4" />,
    },
    {
      label: "利用状況",
      path: "/usage",
      active: props.route.name === "usage",
      icon: <UsageIcon className="h-4 w-4" />,
    },
    {
      label: "ナレッジ",
      path: "/knowledge",
      active: props.route.name === "knowledge",
      icon: <BookIcon className="h-4 w-4" />,
    },
    {
      label: "スケジュール",
      path: "/schedules",
      active: props.route.name === "schedules",
      icon: <CalendarIcon className="h-4 w-4" />,
    },
    {
      label: "設定",
      path: "/settings",
      active: props.route.name === "settings",
      icon: <SettingsIcon className="h-4 w-4" />,
    },
  ];
  const moreNavActive = secondaryNavItems.some((item) => item.active);
  const closeMoreNav = (): void => {
    setMoreNavOpen(false);
  };

  useEffect(() => {
    setMoreNavOpen(false);
  }, [props.route]);

  const prepareHumanDecisions = (): void => {
    if (moreNavOpen) {
      // ドロワーへの操作中は Popover の focus 復帰で移動先を奪わない。
      transferringFocus.current = true;
      setMoreNavOpen(false);
    }
  };

  return (
    <div className={rootClass}>
      <header className="relative z-50 h-12 shrink-0 border-b border-line bg-surface/90 backdrop-blur transition-colors">
        <div className="flex h-12 w-full items-center gap-2 px-2 sm:px-4">
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm" aria-label="パンくず">
            <button
              type="button"
              aria-label="board"
              onClick={() => props.onNavigate("/")}
              className="inline-flex shrink-0 items-center gap-1.5 font-semibold text-ink transition hover:text-accent-strong"
            >
              {/* 柴犬ロゴ。ボタンに aria-label="board" があるため画像は装飾扱いにする。 */}
              <img
                src="/icons/shiba.svg"
                alt=""
                aria-hidden="true"
                data-testid="appshell-logo"
                className="h-5 w-5 shrink-0"
              />
              hachi
            </button>
            {breadcrumbs.map((crumb) => (
              <span key={`${crumb.path ?? "current"}-${crumb.label}`} className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-line">/</span>
                {crumb.path !== undefined ? (
                  <button
                    type="button"
                    onClick={() => props.onNavigate(crumb.path ?? "/")}
                    className="min-w-0 truncate text-ink-muted transition hover:text-accent-strong"
                  >
                    {crumb.label}
                  </button>
                ) : (
                  <span className="min-w-0 truncate font-medium text-ink" aria-current="page">
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1.5">
            <SearchInput controls={props.boardControls} className="hidden w-56 md:block lg:w-72" />

            <Popover.Root open={mobileSearchOpen} onOpenChange={setMobileSearchOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="検索と絞り込みを開く"
                  className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-line bg-surface text-ink-muted transition hover:bg-surface-muted md:hidden"
                >
                  <SearchIcon className="h-4 w-4" />
                  {activeFilterCount > 0 ? (
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent-strong px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  aria-label="検索と絞り込み"
                  className="z-50 w-[calc(100vw-1rem)] max-w-sm rounded-md border border-line bg-surface p-3 outline-none"
                >
                  <FilterFields controls={props.boardControls} includeSearch={true} onClear={clearFilters} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <Popover.Root open={filterOpen} onOpenChange={setFilterOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="絞り込みを開く"
                  className="relative hidden h-9 w-9 items-center justify-center rounded-md border border-line bg-surface text-ink-muted transition hover:bg-surface-muted md:inline-flex"
                >
                  <FilterIcon className="h-4 w-4" />
                  {activeFilterCount > 0 ? (
                    <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-accent-strong px-1 text-center text-[10px] font-semibold leading-4 text-on-accent">
                      {activeFilterCount}
                    </span>
                  ) : null}
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  aria-label="絞り込み"
                  className="z-50 w-72 rounded-md border border-line bg-surface p-3 outline-none"
                >
                  <FilterFields controls={props.boardControls} includeSearch={false} onClear={clearFilters} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <div className="md:hidden" data-testid="appshell-mobile-sessions">
              <HeaderIconButton
                label="sessions"
                active={props.route.name === "sessions" || props.route.name === "session"}
                badge={sessionCount}
                onClick={() => props.onNavigate("/sessions")}
              >
                <SessionsIcon className="h-4 w-4" />
              </HeaderIconButton>
            </div>

            <div className="hidden items-center gap-1.5 md:flex" data-testid="appshell-desktop-nav">
              <HeaderIconButton
                label="sessions"
                active={props.route.name === "sessions" || props.route.name === "session"}
                badge={sessionCount}
                onClick={() => props.onNavigate("/sessions")}
              >
                <SessionsIcon className="h-4 w-4" />
              </HeaderIconButton>

            </div>
            {props.headerHumanDecisions !== undefined ? (
              <div className="shrink-0" onPointerDownCapture={prepareHumanDecisions} onFocusCapture={prepareHumanDecisions}>
                {props.headerHumanDecisions}
              </div>
            ) : null}

            <Popover.Root
              open={moreNavOpen}
              onOpenChange={(open) => {
                if (open) {
                  transferringFocus.current = false;
                  setMoreNavOpen(true);
                } else {
                  closeMoreNav();
                }
              }}
            >
              <Popover.Trigger asChild>
                <button
                  ref={moreNavTriggerRef}
                  type="button"
                  aria-label="その他"
                  title="その他"
                  data-testid="appshell-more-nav-trigger"
                  className={`relative inline-flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-md border transition focus-visible:ring-2 focus-visible:ring-accent md:w-auto md:px-3 ${
                    moreNavActive
                      ? "border-accent/30 bg-accent-soft text-accent-strong"
                      : "border-line bg-surface text-ink-muted hover:bg-surface-muted"
                  }`}
                >
                  <MoreIcon className="h-4 w-4" />
                  <span className="hidden md:inline">その他</span>
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  align="end"
                  sideOffset={8}
                  collisionPadding={12}
                  aria-label="その他のナビゲーション"
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    if (!transferringFocus.current) {
                      moreNavTriggerRef.current?.focus();
                    }
                    transferringFocus.current = false;
                  }}
                  className="z-50 max-h-[var(--radix-popover-content-available-height)] w-60 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-md border border-line bg-surface p-2 outline-none"
                >
                  <div className="flex flex-col gap-1.5">
                    {secondaryNavItems.map((item) => (
                      <HeaderMenuButton
                        key={item.path}
                        label={item.label}
                        active={item.active}
                        onClick={() => {
                          closeMoreNav();
                          props.onNavigate(item.path);
                        }}
                      >
                        {item.icon}
                      </HeaderMenuButton>
                    ))}
                  </div>
                  <hr className="my-2 border-line" />
                  <fieldset className="flex flex-col gap-1" role="radiogroup" aria-label="テーマ">
                    <legend className="px-3 text-xs text-ink-muted">テーマ</legend>
                    {([
                      { value: "light", label: "ライト" },
                      { value: "dark", label: "ダーク" },
                      { value: "system", label: "システム" },
                    ] as const).map((option) => (
                      <label key={option.value} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-3 text-sm text-ink hover:bg-surface-muted">
                        <input type="radio" name="header-theme" value={option.value} checked={preference === option.value}
                          onChange={() => setPreference(option.value)} className="h-4 w-4 accent-accent" />
                        {option.label}
                      </label>
                    ))}
                  </fieldset>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <SupervisorPanel boardCounts={props.boardCounts} />
          </div>
        </div>
      </header>
      {props.children}
    </div>
  );
}
