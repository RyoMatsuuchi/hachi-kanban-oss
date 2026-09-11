// =============================================================================
// SchedulesView のフォーム候補とモバイル順序の回帰テスト。
// =============================================================================

// @vitest-environment jsdom

import type { JSX } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ScheduleFormOptionsResponse,
  ScheduleWithNextFire,
  ScheduleWriteRequest,
  SchedulesResponse,
} from "../../shared/api-types.js";
import type { UseScheduleOptionsResult } from "../hooks/use-schedule-options.js";
import type { UseSchedulesResult } from "../hooks/use-schedules.js";
import { SchedulesView } from "./SchedulesView.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface MockSelectOption {
  value: string;
  label: string;
}

interface MockSelectFieldProps {
  label: string;
  value: string;
  options: readonly MockSelectOption[];
  onValueChange: (value: string) => void;
}

interface RenderedSchedulesView {
  container: HTMLDivElement;
  root: Root;
}

const mocks = vi.hoisted(() => ({
  useSchedules: vi.fn<() => UseSchedulesResult>(),
  useScheduleOptions: vi.fn<() => UseScheduleOptionsResult>(),
  postSchedule: vi.fn<(requestBody: ScheduleWriteRequest) => Promise<ScheduleWithNextFire>>(),
  patchSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  reloadSchedules: vi.fn<() => void>(),
  reloadScheduleOptions: vi.fn<() => void>(),
}));

vi.mock("../hooks/use-schedules.js", () => ({
  useSchedules: mocks.useSchedules,
}));

vi.mock("../hooks/use-schedule-options.js", () => ({
  useScheduleOptions: mocks.useScheduleOptions,
}));

vi.mock("../lib/api.js", () => ({
  deleteSchedule: mocks.deleteSchedule,
  patchSchedule: mocks.patchSchedule,
  postSchedule: mocks.postSchedule,
}));

vi.mock("./SelectField.js", () => ({
  SelectField: (props: MockSelectFieldProps): JSX.Element => (
    <label>
      {props.label}
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onValueChange(event.currentTarget.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  ),
}));

const OPTIONS_RESPONSE: ScheduleFormOptionsResponse = {
  cwds: ["/tmp/hk-scheduler"],
  tenants: ["dev"],
  profiles: [
    { name: "implement", provider: "codex", model: "gpt-5.4", isDefault: true },
    { name: "review", provider: "claude", model: "claude-sonnet-5", isDefault: false },
  ],
};

const SCHEDULES_RESPONSE: SchedulesResponse = {
  schedules: [],
  now: 1_700_000_000,
};

function fixtureSchedule(overrides: Partial<ScheduleWithNextFire> = {}): ScheduleWithNextFire {
  return {
    id: "s_fixture",
    name: "fixture",
    enabled: true,
    cadenceKind: "daily",
    atHour: 9,
    atMinute: 0,
    weekday: null,
    dayOfMonth: null,
    runDate: null,
    tenant: "dev",
    profile: "",
    cwd: "/tmp/hk-scheduler",
    prompt: "run",
    priority: 0,
    lastRunAt: null,
    lastTaskId: "",
    consecutiveFailures: 0,
    autoDisabledReason: "",
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    nextFireAt: 1_700_003_600,
    ...overrides,
  };
}

function requiredElement<T extends Element>(root: ParentNode, selector: string, ctor: { new (): T }): T {
  const element = root.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`element not found: ${selector}`);
  }
  return element;
}

function labelByText(root: ParentNode, text: string): HTMLLabelElement {
  const labels = Array.from(root.querySelectorAll("label"));
  const label = labels.find((element) => {
    const firstText = Array.from(element.childNodes)
      .find((node) => node.nodeType === Node.TEXT_NODE)
      ?.textContent?.trim();
    return firstText === text;
  });
  if (!(label instanceof HTMLLabelElement)) {
    throw new Error(`label not found: ${text}`);
  }
  return label;
}

function fieldByLabel<T extends HTMLInputElement | HTMLTextAreaElement>(
  root: ParentNode,
  text: string,
  selector: string,
  ctor: { new (): T },
): T {
  const label = labelByText(root, text);
  const element = label.querySelector(selector);
  if (!(element instanceof ctor)) {
    throw new Error(`field not found: ${text}`);
  }
  return element;
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

async function setSelectValue(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function renderSchedulesView(): Promise<RenderedSchedulesView> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SchedulesView />);
    await Promise.resolve();
  });
  return { container, root };
}

beforeEach(() => {
  mocks.useSchedules.mockReturnValue({
    data: SCHEDULES_RESPONSE,
    error: null,
    loading: false,
    reload: mocks.reloadSchedules,
  });
  mocks.useScheduleOptions.mockReturnValue({
    data: OPTIONS_RESPONSE,
    error: null,
    loading: false,
    reload: mocks.reloadScheduleOptions,
  });
  mocks.postSchedule.mockResolvedValue(fixtureSchedule());
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("SchedulesView", () => {
  it("profile を非既定から defaultProfile 委任に戻すと空 profile で送信する", async () => {
    const rendered = await renderSchedulesView();
    const initialProfileSelect = requiredElement(
      rendered.container,
      'select[aria-label="profile"]',
      HTMLSelectElement,
    );
    const delegateOption = initialProfileSelect.options.item(0);
    if (delegateOption === null) {
      throw new Error("delegate option not found");
    }

    expect(delegateOption.textContent).toBe("defaultProfile に委任 (implement)");
    expect(initialProfileSelect.value).toBe(delegateOption.value);

    await setSelectValue(initialProfileSelect, "review");
    const reviewProfileSelect = requiredElement(
      rendered.container,
      'select[aria-label="profile"]',
      HTMLSelectElement,
    );
    expect(reviewProfileSelect.value).toBe("review");

    await setSelectValue(reviewProfileSelect, delegateOption.value);
    await setTextValue(fieldByLabel(rendered.container, "name", "input", HTMLInputElement), "朝の巡回");
    await setTextValue(fieldByLabel(rendered.container, "cwd", "input", HTMLInputElement), "/tmp/hk-scheduler");
    await setTextValue(fieldByLabel(rendered.container, "tenant", "input", HTMLInputElement), "dev");
    await setTextValue(fieldByLabel(rendered.container, "prompt", "textarea", HTMLTextAreaElement), "run");

    const form = requiredElement(rendered.container, "form", HTMLFormElement);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.postSchedule).toHaveBeenCalledTimes(1);
    expect(mocks.postSchedule.mock.calls[0]?.[0]).toMatchObject({
      name: "朝の巡回",
      cwd: "/tmp/hk-scheduler",
      tenant: "dev",
      profile: "",
      prompt: "run",
    });
  });

  it("小画面の自然な入力順にするため prompt を作成ボタンより前に置く", async () => {
    const rendered = await renderSchedulesView();
    const promptLabel = labelByText(rendered.container, "prompt");
    const submitButton = requiredElement(rendered.container, 'button[type="submit"]', HTMLButtonElement);
    const actionContainer = submitButton.parentElement;
    if (!(actionContainer instanceof HTMLDivElement)) {
      throw new Error("action container not found");
    }

    expect(promptLabel.compareDocumentPosition(actionContainer) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(promptLabel.className).toContain("order-4");
    expect(actionContainer.className).toContain("order-5");
    expect(actionContainer.className).toContain("md:order-4");
  });
});
