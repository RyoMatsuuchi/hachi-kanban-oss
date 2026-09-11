// =============================================================================
// knowledge 閲覧画面（docs/contract.md §47.5）。
// 一覧・検索・tag/source フィルタ・本文表示だけを提供する read-only ビュー。
// =============================================================================

import type { ChangeEvent, JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import type { KnowledgeRow } from "@hachi/core";
import { useDebouncedValue } from "../hooks/use-debounced-value.js";
import { fetchKnowledge } from "../lib/api.js";
import { formatTimestamp } from "../lib/format.js";

const FIELD_CLASS =
  "h-9 min-w-0 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none transition placeholder:text-ink-muted hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent";
const FILTER_LABEL_CLASS = "grid min-w-0 gap-1 text-xs font-semibold text-ink-muted";

interface KnowledgeState {
  rows: KnowledgeRow[];
  loading: boolean;
  error: string | null;
}

function useKnowledgeRows(tag: string, source: string, query: string): KnowledgeState {
  const [state, setState] = useState<KnowledgeState>({ rows: [], loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true, error: null }));
    fetchKnowledge({ tag, source, q: query }, controller.signal)
      .then((response) => {
        setState({ rows: response.knowledge, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setState({
          rows: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [tag, source, query]);

  return state;
}

function Tags(props: { tags: readonly string[] }): JSX.Element {
  if (props.tags.length === 0) {
    return <span className="text-xs text-ink-muted">-</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {props.tags.map((tag) => (
        <span
          key={tag}
          className="max-w-32 truncate rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent-strong"
          title={tag}
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

function KnowledgeRowButton(props: {
  row: KnowledgeRow;
  selected: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => props.onSelect(props.row.id)}
      className={`grid w-full min-w-0 grid-cols-1 gap-2 border-b border-line px-3 py-3 text-left transition last:border-0 md:grid-cols-[minmax(14rem,1fr)_minmax(8rem,14rem)_5rem_9rem_10rem] md:items-center ${
        props.selected ? "bg-accent-soft" : "bg-surface hover:bg-surface-muted"
      }`}
      aria-pressed={props.selected}
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-ink" title={props.row.title}>
          {props.row.title}
        </div>
        <div className="mt-1 break-all font-mono text-[11px] text-ink-muted md:hidden">{props.row.id}</div>
      </div>
      <Tags tags={props.row.tags} />
      <div className="font-mono text-xs tabular-nums text-ink-muted">imp {props.row.importance}</div>
      <div className="truncate text-xs text-ink-muted" title={props.row.source}>
        {props.row.source}
      </div>
      <div className="font-mono text-xs tabular-nums text-ink-muted">{formatTimestamp(props.row.createdAt)}</div>
    </button>
  );
}

function DetailPane(props: { row: KnowledgeRow | null }): JSX.Element {
  if (props.row === null) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-md border border-line bg-surface px-4 py-10 text-sm text-ink-muted">
        行を選択してください
      </div>
    );
  }

  return (
    <article className="min-h-64 rounded-md border border-line bg-surface">
      <div className="border-b border-line px-4 py-3">
        <h2 className="break-words text-base font-semibold text-ink">{props.row.title}</h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="font-semibold uppercase text-ink-muted">source</dt>
            <dd className="mt-1 truncate text-ink" title={props.row.source}>
              {props.row.source}
            </dd>
          </div>
          <div>
            <dt className="font-semibold uppercase text-ink-muted">importance</dt>
            <dd className="mt-1 font-mono tabular-nums text-ink">{props.row.importance}</dd>
          </div>
          <div>
            <dt className="font-semibold uppercase text-ink-muted">created</dt>
            <dd className="mt-1 font-mono tabular-nums text-ink">{formatTimestamp(props.row.createdAt)}</dd>
          </div>
          <div>
            <dt className="font-semibold uppercase text-ink-muted">tags</dt>
            <dd className="mt-1">
              <Tags tags={props.row.tags} />
            </dd>
          </div>
        </dl>
      </div>
      <pre className="max-h-[calc(100vh-15rem)] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-sm leading-6 text-ink">{props.row.body}</pre>
    </article>
  );
}

export function KnowledgeView(): JSX.Element {
  const [queryInput, setQueryInput] = useState<string>("");
  const [tag, setTag] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useDebouncedValue(queryInput, 300);
  const { rows, loading, error } = useKnowledgeRows(tag.trim(), source.trim(), query.trim());
  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (selectedId !== null && !rows.some((row) => row.id === selectedId)) {
      setSelectedId(null);
    }
  }, [rows, selectedId]);

  const onQueryChange = (event: ChangeEvent<HTMLInputElement>): void => setQueryInput(event.target.value);
  const onTagChange = (event: ChangeEvent<HTMLInputElement>): void => setTag(event.target.value);
  const onSourceChange = (event: ChangeEvent<HTMLInputElement>): void => setSource(event.target.value);

  return (
    <main className="mx-auto grid max-w-7xl gap-4 px-2 py-4 sm:px-4 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,0.9fr)]">
      <section className="min-w-0 space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-end">
          <label className={`${FILTER_LABEL_CLASS} md:flex-1`}>
            検索
            <input
              type="search"
              value={queryInput}
              onChange={onQueryChange}
              placeholder="title / body"
              aria-label="knowledge 検索"
              className={FIELD_CLASS}
            />
          </label>
          <label className={`${FILTER_LABEL_CLASS} md:w-48`}>
            tag
            <input
              type="search"
              value={tag}
              onChange={onTagChange}
              placeholder="handover"
              aria-label="tag フィルタ"
              className={FIELD_CLASS}
            />
          </label>
          <label className={`${FILTER_LABEL_CLASS} md:w-56`}>
            source
            <input
              type="search"
              value={source}
              onChange={onSourceChange}
              placeholder="session-handover"
              aria-label="source フィルタ"
              className={FIELD_CLASS}
            />
          </label>
        </div>

        {error !== null ? (
          <div className="rounded-md border border-danger-strong/30 bg-danger-soft px-3 py-2 text-sm text-danger-strong">
            {error}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-md border border-line bg-surface">
          <div className="hidden grid-cols-[minmax(14rem,1fr)_minmax(8rem,14rem)_5rem_9rem_10rem] border-b border-line bg-surface-muted px-3 py-2 text-[11px] font-semibold uppercase text-ink-muted md:grid">
            <span>title</span>
            <span>tags</span>
            <span>imp</span>
            <span>source</span>
            <span>created</span>
          </div>
          {loading && rows.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-ink-muted">knowledge を読み込み中...</div>
          ) : null}
          {!loading && rows.length === 0 ? (
            <div className="px-3 py-10 text-center text-sm text-ink-muted">knowledge はありません</div>
          ) : null}
          {rows.map((row) => (
            <KnowledgeRowButton
              key={row.id}
              row={row}
              selected={row.id === selectedId}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      </section>

      <section className="min-w-0">
        <DetailPane row={selected} />
      </section>
    </main>
  );
}
