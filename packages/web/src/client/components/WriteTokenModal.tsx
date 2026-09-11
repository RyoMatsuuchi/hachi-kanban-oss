// =============================================================================
// web write API 用 token 入力モーダル（docs/contract.md §31.2）。
// fetch 層から prompt 登録を受け、同時 401 は api.ts 側の多重表示ガードで 1 枚に集約される。
// =============================================================================

import * as Dialog from "@radix-ui/react-dialog";
import type { FormEvent, JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { setWriteTokenPrompt } from "../lib/api.js";

type PromptResolver = (token: string | null) => void;

export function WriteTokenModal(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const resolverRef = useRef<PromptResolver | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const returnDialogRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function resolvePending(value: string | null): void {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOpen(false);
    setToken("");
    setError(null);
  }

  useEffect(() => {
    setWriteTokenPrompt(
      () =>
        new Promise<string | null>((resolve) => {
          returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          returnDialogRef.current = returnFocusRef.current?.closest<HTMLElement>('[role="dialog"]')
            ?? Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).at(-1) ?? null;
          resolverRef.current = resolve;
          setToken("");
          setError(null);
          setOpen(true);
        }),
    );
    return () => {
      setWriteTokenPrompt(null);
      resolverRef.current?.(null);
      resolverRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = token.trim();
    if (normalized === "") {
      setError("token を入力してください");
      return;
    }
    resolvePending(normalized);
  }

  if (!open) {
    return null;
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) resolvePending(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay backdrop-blur-sm" />
        <Dialog.Content
          data-write-token-dialog=""
          onPointerDownOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // 送信中の起点はdisabledになり得るため、背面ダイアログ内の有効な要素へ戻す。
            const previous = returnFocusRef.current;
            if (previous?.isConnected && !previous.matches(":disabled")) previous.focus();
            const dialog = returnDialogRef.current;
            if (dialog?.isConnected && !dialog.contains(document.activeElement)) {
              const fallback = dialog.querySelector<HTMLElement>('[tabindex="-1"], button:not(:disabled), input:not(:disabled)');
              (fallback ?? dialog).focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-[61] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2"
        >
      <form
        className="w-full max-w-md rounded-md border border-line bg-surface p-3"
        onSubmit={submit}
      >
        <div className="space-y-1">
          <Dialog.Title className="text-sm font-semibold text-ink">
            web write token
          </Dialog.Title>
          <Dialog.Description className="text-sm text-ink-muted">write API の認証に必要です。</Dialog.Description>
        </div>
        <label className="mt-4 grid gap-1 text-xs font-semibold text-ink-muted">
          token
          <input
            ref={inputRef}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
        {error !== null ? <p className="mt-2 text-sm text-danger-strong">{error}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => resolvePending(null)}
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink transition hover:bg-surface-muted"
          >
            キャンセル
          </button>
          <button
            type="submit"
            className="h-9 rounded-md bg-accent-strong px-3 text-sm font-semibold text-on-accent transition hover:brightness-95"
          >
            保存
          </button>
        </div>
      </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
