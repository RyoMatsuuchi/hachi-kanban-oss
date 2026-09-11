// =============================================================================
// テーマ切替ボタン（light/dark/system の3値トグル）。
// Radix 不要のシンプルな button group。状態管理・永続化・<html> への反映は
// useTheme フック（src/client/hooks/use-theme.ts）が担当する。
// AppShell ヘッダーから使う共通コンポーネント。
// =============================================================================

import type { JSX } from "react";
import { useTheme, type ThemePreference } from "../hooks/use-theme.js";

const OPTIONS: readonly { value: ThemePreference; label: string; icon: string }[] = [
  { value: "light", label: "ライト", icon: "☀️" },
  { value: "dark", label: "ダーク", icon: "🌙" },
  { value: "system", label: "システム", icon: "🖥️" },
];

export interface ThemeToggleProps {
  compact?: boolean;
}

function nextPreference(current: ThemePreference): ThemePreference {
  const index = OPTIONS.findIndex((option) => option.value === current);
  return OPTIONS[(index + 1) % OPTIONS.length]?.value ?? "system";
}

export function ThemeToggle(props: ThemeToggleProps): JSX.Element {
  const { preference, setPreference } = useTheme();
  const activeOption =
    OPTIONS.find((option) => option.value === preference) ?? { value: "system", label: "システム", icon: "🖥️" };

  if (props.compact === true) {
    return (
      <button
        type="button"
        title={`テーマ: ${activeOption.label}`}
        aria-label={`テーマ: ${activeOption.label}`}
        onClick={() => setPreference(nextPreference(preference))}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-sm leading-none text-ink-muted transition hover:bg-surface-muted"
      >
        <span aria-hidden="true">{activeOption.icon}</span>
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="テーマ切替"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-muted p-0.5 transition-colors"
    >
      {OPTIONS.map((option) => {
        const active = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.label}
            onClick={() => setPreference(option.value)}
            className={`flex h-9 w-9 items-center justify-center rounded-md text-sm leading-none transition-colors ${
              active
                ? "bg-surface text-ink ring-1 ring-line"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <span aria-hidden="true">{option.icon}</span>
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
