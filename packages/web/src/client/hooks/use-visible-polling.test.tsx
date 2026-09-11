// =============================================================================
// useVisiblePolling の可視/非表示ポーリング挙動の回帰テスト（docs/contract.md §20/§37.7）。
// =============================================================================

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisiblePolling } from "./use-visible-polling.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface ProbeProps {
  callback: () => void;
  intervalMs: number;
  hiddenIntervalMs?: number;
}

function Probe(props: ProbeProps): null {
  useVisiblePolling(props.callback, props.intervalMs, props.hiddenIntervalMs);
  return null;
}

/** document.hidden を差し替える（jsdom の既定は visible）。 */
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

async function renderProbe(props: ProbeProps): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe {...props} />);
  });
  return root;
}

/** interval だけを fake にして、React の act/scheduler を実タイマーのまま保つ。 */
function useIntervalFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  Reflect.deleteProperty(document, "hidden");
  document.body.replaceChildren();
  await Promise.resolve();
});

describe("useVisiblePolling", () => {
  it("hiddenIntervalMs 未指定なら従来どおり表示中だけ intervalMs で呼ぶ", async () => {
    useIntervalFakeTimers();
    const callback = vi.fn();
    const root = await renderProbe({ callback, intervalMs: 5_000 });

    advance(15_000);
    expect(callback).toHaveBeenCalledTimes(3);

    setHidden(true);
    advance(15_000);
    expect(callback).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it("hiddenIntervalMs 未指定なら非表示中は一切呼ばない（後方互換）", async () => {
    useIntervalFakeTimers();
    setHidden(true);
    const callback = vi.fn();
    const root = await renderProbe({ callback, intervalMs: 5_000 });

    advance(60_000);
    expect(callback).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("hiddenIntervalMs 指定時は非表示中だけ低頻度で呼ぶ", async () => {
    useIntervalFakeTimers();
    setHidden(true);
    const callback = vi.fn();
    const root = await renderProbe({ callback, intervalMs: 5_000, hiddenIntervalMs: 30_000 });

    advance(90_000);
    // 通常間隔（5s×18回）は非表示中 skip され、低頻度側の 3 回だけが残る。
    expect(callback).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it("hiddenIntervalMs 指定でも表示中は二重フェッチしない", async () => {
    useIntervalFakeTimers();
    const callback = vi.fn();
    const root = await renderProbe({ callback, intervalMs: 5_000, hiddenIntervalMs: 30_000 });

    advance(60_000);
    // 表示中に呼ばれるのは通常間隔の 12 回のみ（低頻度側は何もしない）。
    expect(callback).toHaveBeenCalledTimes(12);

    await act(async () => root.unmount());
  });

  it("unmount で両方の interval を止める", async () => {
    useIntervalFakeTimers();
    const callback = vi.fn();
    const root = await renderProbe({ callback, intervalMs: 5_000, hiddenIntervalMs: 30_000 });

    advance(10_000);
    expect(callback).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());

    setHidden(true);
    advance(120_000);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
