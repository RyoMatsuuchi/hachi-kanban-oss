// =============================================================================
// history API + useState による軽量ルーティング（/・/task/:id・/schedules・/sessions・/session/:id）。
// 外部 router 依存を増やさない方針（docs/contract.md §20 実装指示）。
// =============================================================================

import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "board" }
  | { name: "task"; taskId: string }
  | { name: "schedules" }
  | { name: "knowledge" }
  | { name: "sessions" }
  | { name: "session"; sessionId: string }
  | { name: "settings" }
  | { name: "metrics" }
  | { name: "usage" };

const TASK_PATH_PATTERN = /^\/task\/([^/]+)\/?$/;
const SESSION_PATH_PATTERN = /^\/session\/([^/]+)\/?$/;

function parseRoute(pathname: string): Route {
  if (pathname === "/metrics" || pathname === "/metrics/") {
    return { name: "metrics" };
  }
  if (pathname === "/usage" || pathname === "/usage/") {
    return { name: "usage" };
  }
  if (pathname === "/settings" || pathname === "/settings/") {
    return { name: "settings" };
  }
  if (pathname === "/schedules" || pathname === "/schedules/") {
    return { name: "schedules" };
  }
  if (pathname === "/knowledge" || pathname === "/knowledge/") {
    return { name: "knowledge" };
  }
  const match = TASK_PATH_PATTERN.exec(pathname);
  if (match !== null && match[1] !== undefined) {
    return { name: "task", taskId: decodeURIComponent(match[1]) };
  }
  if (pathname === "/sessions" || pathname === "/sessions/") {
    return { name: "sessions" };
  }
  const sessionMatch = SESSION_PATH_PATTERN.exec(pathname);
  if (sessionMatch !== null && sessionMatch[1] !== undefined) {
    return { name: "session", sessionId: decodeURIComponent(sessionMatch[1]) };
  }
  return { name: "board" };
}

export interface Navigation {
  route: Route;
  /** history.pushState + 内部状態更新でページ全体の再読み込み無しに遷移する */
  navigate: (path: string) => void;
}

export function useNavigation(): Navigation {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string): void => {
    if (path !== window.location.pathname) {
      window.history.pushState({}, "", path);
    }
    setRoute(parseRoute(path));
  }, []);

  return { route, navigate };
}
