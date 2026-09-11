// =============================================================================
// SettingsView の smoke test。フォーム/Raw JSON の双方向性と 409 表示を検証する。
// =============================================================================

// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigGetResponse, ConfigPutRequest, ConfigPutResponse } from "../../shared/api-types.js";
import { SettingsView } from "./SettingsView.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface RenderedSettingsView {
  container: HTMLDivElement;
  root: Root;
}

interface ApiErrorCtor {
  new (message: string, status?: number, issues?: readonly string[]): Error & {
    readonly status?: number;
    readonly issues?: readonly string[];
  };
}

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      message: string,
      public readonly status?: number,
      public readonly issues?: readonly string[],
    ) {
      super(message);
      this.name = "ApiError";
    }
  }

  return {
    ApiError: MockApiError,
    fetchConfig: vi.fn<() => Promise<ConfigGetResponse>>(),
    putConfig: vi.fn<(requestBody: ConfigPutRequest) => Promise<ConfigPutResponse>>(),
  };
});

vi.mock("../lib/api.js", () => ({
  ApiError: mocks.ApiError,
  fetchConfig: mocks.fetchConfig,
  putConfig: mocks.putConfig,
}));

function configFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    resourceGuard: { maxInFlight: 10, maxLaunchesPerTick: 2 },
    defaultProfile: "implement",
    steward: { intervalMinutes: 10 },
    review: { maxReworkLaunches: 1 },
    "future-section": { preserved: true },
    ...overrides,
  };
}

function configResponse(config: Record<string, unknown> = configFixture()): ConfigGetResponse {
  return { exists: true, config, etag: "etag-1" };
}

async function renderSettingsView(): Promise<RenderedSettingsView> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SettingsView />);
    await Promise.resolve();
  });
  await waitFor(() => expect(mocks.fetchConfig).toHaveBeenCalledTimes(1));
  return { container, root };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string, ctor: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll("button")).find((element) => element.textContent === text);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${text}`);
  }
  return button;
}

async function setTextValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function submit(container: ParentNode): Promise<void> {
  const form = requiredElement(container, "form", HTMLFormElement);
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mocks.fetchConfig.mockResolvedValue(configResponse());
  mocks.putConfig.mockResolvedValue({ etag: "etag-2", meta: { applies: "next-tick" }, changedSections: ["profiles"] });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("SettingsView", () => {
  it("フォーム編集から完全形 JSON を維持した PUT payload を作る", async () => {
    const rendered = await renderSettingsView();
    const modelInput = requiredElement(
      rendered.container,
      '[data-testid="settings-profile-model-implement"]',
      HTMLInputElement,
    );

    await setTextValue(modelInput, "gpt-5.5");
    await submit(rendered.container);

    await waitFor(() => expect(mocks.putConfig).toHaveBeenCalledTimes(1));
    const request = mocks.putConfig.mock.calls[0]?.[0];
    expect(request?.baseEtag).toBe("etag-1");
    const config = request?.config as Record<string, unknown>;
    expect(config.allowlist).toEqual({
      codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
      claude: ["claude-opus-5", "claude-opus-4-6", "claude-sonnet-5"],
    });
    expect(config.resourceGuard).toEqual({ maxInFlight: 10, maxLaunchesPerTick: 2 });
    expect(config["future-section"]).toEqual({ preserved: true });
    expect(config.profiles).toMatchObject({ implement: { model: "gpt-5.5" } });
  });

  it("profile effort=max を load 後のフォーム編集・保存でも保持する", async () => {
    const rendered = await renderSettingsView();
    const effortSelect = requiredElement(
      rendered.container,
      '[data-testid="settings-profile-effort-implement"]',
      HTMLSelectElement,
    );
    const modelInput = requiredElement(
      rendered.container,
      '[data-testid="settings-profile-model-implement"]',
      HTMLInputElement,
    );

    expect(effortSelect.value).toBe("max");
    expect(Array.from(effortSelect.options).map((option) => option.value)).toContain("max");

    await setTextValue(modelInput, "gpt-5.6-terra");
    await submit(rendered.container);

    await waitFor(() => expect(mocks.putConfig).toHaveBeenCalledTimes(1));
    const request = mocks.putConfig.mock.calls[0]?.[0];
    const config = request?.config as { profiles?: { implement?: Record<string, unknown> } };
    expect(config.profiles?.implement).toMatchObject({
      model: "gpt-5.6-terra",
      transport: "direct",
      effort: "max",
      speed: "standard",
    });

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("profile model 入力に provider 別 allowlist の Codex 5.6 候補を表示する", async () => {
    const rendered = await renderSettingsView();
    const modelInput = requiredElement(
      rendered.container,
      '[data-testid="settings-profile-model-implement"]',
      HTMLInputElement,
    );
    const options = Array.from(
      rendered.container.querySelectorAll('#settings-model-options-codex option'),
    ).map((option) => option.getAttribute("value"));

    expect(modelInput.getAttribute("list")).toBe("settings-model-options-codex");
    expect(options).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
    ]);

    await act(async () => {
      rendered.root.unmount();
    });
  });

  it("Raw JSON の変更をフォームへ反映する", async () => {
    const rendered = await renderSettingsView();
    await click(buttonByText(rendered.container, "Raw JSON"));
    const raw = requiredElement(rendered.container, '[data-testid="settings-raw-json"]', HTMLTextAreaElement);
    const nextConfig = configFixture({ review: { maxReworkLaunches: 1 } });

    await setTextValue(raw, JSON.stringify(nextConfig, null, 2));
    await click(buttonByText(rendered.container, "フォーム"));

    const reviewInput = requiredElement(
      rendered.container,
      '[data-testid="settings-review-max-rework"]',
      HTMLInputElement,
    );
    expect(reviewInput.value).toBe("1");
    expect(reviewInput.min).toBe("1");
    expect(reviewInput.max).toBe("1");
  });

  it("409 では再読込ボタンを提示する", async () => {
    const ApiError = mocks.ApiError as ApiErrorCtor;
    mocks.putConfig.mockRejectedValue(new ApiError("conflict", 409));
    const rendered = await renderSettingsView();

    await submit(rendered.container);

    await waitFor(() => expect(rendered.container.textContent).toContain("同時更新を検知しました。"));
    expect(buttonByText(rendered.container, "再読込")).not.toBeNull();
  });

  it("401 は従来どおり message をそのまま表示する（issues 混入で退行しない）", async () => {
    const ApiError = mocks.ApiError as ApiErrorCtor;
    mocks.putConfig.mockRejectedValue(new ApiError("write authorization required", 401));
    const rendered = await renderSettingsView();

    await submit(rendered.container);

    await waitFor(() => expect(rendered.container.textContent).toContain("write authorization required"));
    expect(rendered.container.textContent).not.toContain("同時更新を検知しました。");
  });

  it("provider/model の allowlist 違反（server issues）を捨てずに列挙表示する", async () => {
    const ApiError = mocks.ApiError as ApiErrorCtor;
    mocks.putConfig.mockRejectedValue(
      new ApiError("config.json の検証に失敗しました", 400, [
        "profiles.implement.model が allowlist 外です（provider=codex）: claude-sonnet-5",
      ]),
    );
    const rendered = await renderSettingsView();

    await submit(rendered.container);

    await waitFor(() =>
      expect(rendered.container.textContent).toContain(
        "profiles.implement.model が allowlist 外です（provider=codex）: claude-sonnet-5",
      ),
    );
  });

  it("送信前 zod 検証の失敗時にどのフィールドが何故落ちたかを issue 単位で表示する", async () => {
    const rendered = await renderSettingsView();
    await click(buttonByText(rendered.container, "Raw JSON"));
    const raw = requiredElement(rendered.container, '[data-testid="settings-raw-json"]', HTMLTextAreaElement);
    // profiles.implement.model を空文字にして zod の min(1) 違反を起こす
    const invalidConfig = configFixture({
      profiles: {
        implement: { provider: "codex", model: "" },
      },
    });

    await setTextValue(raw, JSON.stringify(invalidConfig, null, 2));
    await submit(rendered.container);

    // submit() 由来のエラーバナー（generic メッセージ + issue 単位の内訳）が両方出ること
    await waitFor(() => expect(rendered.container.textContent).toContain("config.json の検証に失敗しました"));
    expect(rendered.container.textContent).toContain("profiles.implement.model");
    expect(mocks.putConfig).not.toHaveBeenCalled();
  });

  it("フォーム入力で model の zod 違反を起こしたとき putConfig を呼ばず issue を表示する", async () => {
    const rendered = await renderSettingsView();
    const modelInput = requiredElement(
      rendered.container,
      '[data-testid="settings-profile-model-implement"]',
      HTMLInputElement,
    );

    // profiles.<name>.model は z.string().min(1) が課されるため、フォーム上で空文字にすると
    // 送信前 zod 検証（hachiConfigSchema.safeParse）が profiles.implement.model で落ちる。
    await setTextValue(modelInput, "");
    await submit(rendered.container);

    await waitFor(() => expect(rendered.container.textContent).toContain("profiles.implement.model"));
    expect(mocks.putConfig).not.toHaveBeenCalled();
  });
});
