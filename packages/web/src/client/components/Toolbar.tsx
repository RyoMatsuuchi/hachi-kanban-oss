// =============================================================================
// 絞り込みツールバー: tenant Select・表示バケット Select・検索 Input（docs/contract.md §20 実装指示）。
// =============================================================================

import type { JSX } from "react";
import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { SelectField } from "./SelectField.js";
import { SearchIcon } from "./icons.js";
import { DISPLAY_BUCKETS, type DisplayBucket } from "../lib/constants.js";

/** Radix Select は value="" を許容しないため、「全て」用のセンチネル値を使う */
const ALL_TENANT_VALUE = "__all_tenants__";

export interface ToolbarFilterState {
  /** "" = 絞り込み無し（全 tenant） */
  tenant: string;
  bucket: DisplayBucket;
  watchedOnly: boolean;
  query: string;
}

export interface ToolbarProps {
  tenants: string[];
  /** "" = 絞り込み無し（全 tenant） */
  tenant: string;
  bucket: DisplayBucket;
  watchedOnly: boolean;
  query: string;
  onTenantChange: (tenant: string) => void;
  onBucketChange: (bucket: DisplayBucket) => void;
  onWatchedOnlyChange: (watchedOnly: boolean) => void;
  onQueryChange: (query: string) => void;
}

export function countActiveFilters(state: ToolbarFilterState): number {
  let count = 0;
  if (state.tenant !== "") {
    count += 1;
  }
  if (state.bucket !== "all") {
    count += 1;
  }
  if (state.watchedOnly) {
    count += 1;
  }
  if (state.query.trim() !== "") {
    count += 1;
  }
  return count;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const {
    tenants,
    tenant,
    bucket,
    watchedOnly,
    query,
    onTenantChange,
    onBucketChange,
    onWatchedOnlyChange,
    onQueryChange,
  } = props;
  const [mobilePopoverOpen, setMobilePopoverOpen] = useState(false);

  const tenantOptions = [
    { value: ALL_TENANT_VALUE, label: "全て" },
    ...tenants.map((t) => ({ value: t, label: t })),
  ];
  const activeFilterCount = countActiveFilters({ tenant, bucket, watchedOnly, query });

  const clearFilters = (): void => {
    onTenantChange("");
    onBucketChange("all");
    onWatchedOnlyChange(false);
    onQueryChange("");
    setMobilePopoverOpen(false);
  };

  const renderFields = (): JSX.Element => (
    <>
      <SelectField
        label="tenant"
        value={tenant === "" ? ALL_TENANT_VALUE : tenant}
        options={tenantOptions}
        onValueChange={(v) => onTenantChange(v === ALL_TENANT_VALUE ? "" : v)}
      />
      <SelectField
        label="表示バケット"
        value={bucket}
        options={DISPLAY_BUCKETS}
        onValueChange={(v) => onBucketChange(v as DisplayBucket)}
      />
      <label className="flex min-h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink transition hover:bg-surface-muted">
        <input
          type="checkbox"
          checked={watchedOnly}
          onChange={(event) => onWatchedOnlyChange(event.target.checked)}
          className="h-4 w-4 accent-accent"
        />
        ウォッチ中のみ
      </label>
      <div className="flex min-w-[14rem] flex-1 flex-col gap-1">
        <span className="text-xs font-medium text-ink-muted">検索（title / ID）</span>
        <input
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="タイトルまたは ID で絞り込み"
          className="min-h-10 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition placeholder:text-ink-muted hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
        />
      </div>
    </>
  );

  return (
    <>
      <div
        data-testid="toolbar-mobile"
        className="flex items-center gap-2 rounded-md border border-line bg-surface p-2 transition-colors sm:hidden"
      >
        <Popover.Root open={mobilePopoverOpen} onOpenChange={setMobilePopoverOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label="検索と絞り込みを開く"
              className="inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-line bg-surface text-ink-muted outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
            >
              <SearchIcon className="h-5 w-5" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={8}
              collisionPadding={16}
              aria-label="検索と絞り込み"
              className="z-50 w-[calc(100vw-2rem)] max-w-sm rounded-md border border-line bg-surface p-3 outline-none"
            >
              <div className="flex flex-col gap-3">
                {renderFields()}
                <button
                  type="button"
                  onClick={clearFilters}
                  data-testid="toolbar-clear-filters"
                  className="inline-flex min-h-10 items-center justify-center rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
                >
                  クリア
                </button>
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
        {activeFilterCount > 0 ? (
          <span
            data-testid="toolbar-filter-badge"
            className="inline-flex min-h-8 items-center rounded-md border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-strong"
          >
            絞り込み中 {activeFilterCount}
          </span>
        ) : null}
      </div>

      <div
        data-testid="toolbar-desktop"
        className="hidden flex-wrap items-end gap-3 rounded-md border border-line bg-surface p-3 transition-colors sm:flex"
      >
        {renderFields()}
      </div>
    </>
  );
}
