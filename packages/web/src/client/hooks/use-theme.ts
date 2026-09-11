// =============================================================================
// ダークモードのテーマ状態管理フック。
// 'light' | 'dark' | 'system' を localStorage（キー hk-theme）に永続化し、
// document.documentElement の 'dark' クラス付け外しで実際の見た目を切り替える
// （styles.css の @custom-variant dark 定義と対応）。
// 初回描画前の FOUC 防止用 inline script（index.html 参照）と判定ロジックを揃えること。
// =============================================================================

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "hk-theme";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredPreference(): ThemePreference {
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

function resolveIsDark(preference: ThemePreference): boolean {
  return preference === "system" ? systemPrefersDark() : preference === "dark";
}

function applyTheme(preference: ThemePreference): void {
  document.documentElement.classList.toggle("dark", resolveIsDark(preference));
}

export interface UseThemeResult {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
}

/** テーマ設定（light/dark/system）を購読・変更するフック。ボード/詳細画面ヘッダの ThemeToggle から使う */
export function useTheme(): UseThemeResult {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());

  useEffect(() => {
    applyTheme(preference);
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, [preference]);

  // preference === "system" のときは OS 側のテーマ変更（ライブ切替）にも追従する
  useEffect(() => {
    if (preference !== "system") {
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (): void => applyTheme("system");
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
  }, []);

  return { preference, setPreference };
}
