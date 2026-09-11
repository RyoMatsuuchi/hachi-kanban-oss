// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HumanDecisionRequestRow } from "@hachi/core";
import type { HumanDecisionSubmissionState } from "../hooks/use-human-decisions.js";
import { HumanDecisionCard, type HumanDecisionCardProps } from "./HumanDecisionCard.js";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface RenderedCard {
  container: HTMLDivElement;
  root: Root;
  rerender: (props: HumanDecisionCardProps) => Promise<void>;
}

const REQUEST_PROVENANCE: HumanDecisionRequestRow["requestProvenance"] = {
  kind: "orchestrator",
  actorId: "os_0000000000000001",
  actorSessionId: "orchestrator-session",
  actorGeneration: 7,
};

const ANSWER_PROVENANCE: NonNullable<HumanDecisionRequestRow["answerProvenance"]> = {
  kind: "human",
  actorId: "local-human-claim",
  actorSessionId: "",
  actorGeneration: null,
};

const BASE_REQUEST: HumanDecisionRequestRow = {
  id: "hd_0000000000000001",
  taskId: "t_0000000000000001",
  ownerOrchestratorId: "os_0000000000000001",
  kind: "approval",
  title: "公開判断",
  question: "この固定revisionを\n公開してよいですか",
  action: "productionへ公開する",
  targetRevision: { kind: "git_commit", value: "a".repeat(40) },
  choices: [],
  links: [],
  defaultOutcome: "deny",
  relatedRequestId: null,
  deadlineAt: null,
  status: "waiting_human",
  answerRevision: 0,
  answer: null,
  answerComment: null,
  requestProvenance: REQUEST_PROVENANCE,
  answerProvenance: null,
  cancelProvenance: null,
  resolveProvenance: null,
  answeredAt: null,
  claimantOrchestratorId: null,
  claimantSessionId: null,
  claimantGeneration: null,
  claimLeaseUntil: null,
  resolution: null,
  resolvedAt: null,
  cancelReason: null,
  cancelledAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const IDLE_SUBMISSION: HumanDecisionSubmissionState = {
  phase: "idle",
  error: null,
  canSubmit: true,
  canRetry: false,
  pendingAnswer: null,
};

const mountedRoots = new Set<Root>();

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requestRow(overrides: Partial<HumanDecisionRequestRow> = {}): HumanDecisionRequestRow {
  return { ...BASE_REQUEST, ...overrides };
}

function submissionState(
  overrides: Partial<HumanDecisionSubmissionState> = {},
): HumanDecisionSubmissionState {
  return { ...IDLE_SUBMISSION, ...overrides };
}

async function renderCard(props: HumanDecisionCardProps): Promise<RenderedCard> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.add(root);
  await act(async () => {
    root.render(<HumanDecisionCard {...props} />);
    await Promise.resolve();
  });
  return {
    container,
    root,
    rerender: async (nextProps: HumanDecisionCardProps): Promise<void> => {
      await act(async () => {
        root.render(<HumanDecisionCard {...nextProps} />);
        await Promise.resolve();
      });
    },
  };
}

function propsFor(
  request: HumanDecisionRequestRow,
  overrides: Partial<Omit<HumanDecisionCardProps, "request">> = {},
): HumanDecisionCardProps {
  return {
    request,
    submission: IDLE_SUBMISSION,
    onSubmit: async () => undefined,
    onRetry: async () => undefined,
    onOpenTask: () => undefined,
    ...overrides,
  };
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`buttonが見つかりません: ${text}`);
  }
  return button;
}

function fieldByLabel<T extends HTMLSelectElement | HTMLTextAreaElement>(
  container: ParentNode,
  text: string,
  constructor: { new(): T },
): T {
  const label = Array.from(container.querySelectorAll("label"))
    .find((candidate) => candidate.textContent?.includes(text));
  const field = label?.querySelector("select, textarea");
  if (!(field instanceof constructor)) {
    throw new Error(`入力欄が見つかりません: ${text}`);
  }
  return field;
}

async function setTextValue(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function setSelectValue(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(element: HTMLButtonElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

afterEach(async () => {
  for (const root of [...mountedRoots]) {
    mountedRoots.delete(root);
    await act(async () => root.unmount());
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("HumanDecisionCard", () => {
  it("3 kindとdecision 2形式をラベル付き入力から正確なcallback引数へ変換する", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const rendered = await renderCard(propsFor(BASE_REQUEST, { onSubmit }));

    const approvalComment = fieldByLabel(rendered.container, "コメント（任意）", HTMLTextAreaElement);
    await setTextValue(approvalComment, "  承認メモ  ");
    await click(buttonByText(rendered.container, "承認する"));
    await click(buttonByText(rendered.container, "却下する"));
    expect(onSubmit).toHaveBeenNthCalledWith(
      1,
      BASE_REQUEST.id,
      { kind: "approval", outcome: "approve" },
      "承認メモ",
    );
    expect(onSubmit).toHaveBeenNthCalledWith(
      2,
      BASE_REQUEST.id,
      { kind: "approval", outcome: "reject" },
      "承認メモ",
    );

    const review = requestRow({
      id: "hd_review",
      kind: "review",
      action: null,
      targetRevision: { kind: "sha256", value: "b".repeat(64) },
      defaultOutcome: "not_accepted",
    });
    await rendered.rerender(propsFor(review, { onSubmit }));
    await click(buttonByText(rendered.container, "受け入れる"));
    await click(buttonByText(rendered.container, "修正を依頼する"));
    expect(onSubmit).toHaveBeenNthCalledWith(
      3,
      review.id,
      { kind: "review", outcome: "accepted" },
    );
    expect(onSubmit).toHaveBeenNthCalledWith(
      4,
      review.id,
      { kind: "review", outcome: "changes_requested" },
    );

    const choiceDecision = requestRow({
      id: "hd_choice",
      kind: "decision",
      action: null,
      targetRevision: null,
      choices: [
        { id: "retain", label: "現状を維持" },
        { id: "replace", label: "置き換える" },
      ],
      defaultOutcome: "retain_current_state",
    });
    await rendered.rerender(propsFor(choiceDecision, { onSubmit }));
    const select = fieldByLabel(rendered.container, "判断の選択肢", HTMLSelectElement);
    expect(select.value).toBe("");
    expect(buttonByText(rendered.container, "回答を送信").disabled).toBe(true);
    await setSelectValue(select, "replace");
    await click(buttonByText(rendered.container, "回答を送信"));
    expect(onSubmit).toHaveBeenNthCalledWith(
      5,
      choiceDecision.id,
      { kind: "decision", choiceId: "replace" },
    );

    const textDecision = requestRow({
      id: "hd_text",
      kind: "decision",
      action: null,
      targetRevision: null,
      choices: [],
      defaultOutcome: "retain_current_state",
    });
    await rendered.rerender(propsFor(textDecision, { onSubmit }));
    const answer = fieldByLabel(rendered.container, "判断の回答", HTMLTextAreaElement);
    await setTextValue(answer, "  次のrevisionで再確認する  ");
    await click(buttonByText(rendered.container, "回答を送信"));
    expect(onSubmit).toHaveBeenNthCalledWith(
      6,
      textDecision.id,
      { kind: "decision", text: "次のrevisionで再確認する" },
    );
  });

  it("未選択・空・長過ぎ入力と期限だけでは送らず、同id再renderではフォームを保つ", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000 * 1000);
    const onSubmit = vi.fn(async () => undefined);
    const decision = requestRow({
      id: "hd_validation",
      kind: "decision",
      action: null,
      targetRevision: null,
      choices: [],
      defaultOutcome: "retain_current_state",
      deadlineAt: 1_000_000,
    });
    const rendered = await renderCard(propsFor(decision, { onSubmit }));
    expect(rendered.container.textContent).toContain("期限超過");
    expect(onSubmit).toHaveBeenCalledTimes(0);

    const answer = fieldByLabel(rendered.container, "判断の回答", HTMLTextAreaElement);
    await setTextValue(answer, "   ");
    expect(buttonByText(rendered.container, "回答を送信").disabled).toBe(true);
    await setTextValue(answer, "x".repeat(12_001));
    expect(buttonByText(rendered.container, "回答を送信").disabled).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(0);

    await setTextValue(answer, "入力を保持");
    await rendered.rerender(propsFor({ ...decision, updatedAt: 2 }, { onSubmit }));
    expect(fieldByLabel(rendered.container, "判断の回答", HTMLTextAreaElement).value).toBe("入力を保持");

    const approval = requestRow({ id: "hd_long_comment" });
    await rendered.rerender(propsFor(approval, { onSubmit }));
    const comment = fieldByLabel(rendered.container, "コメント（任意）", HTMLTextAreaElement);
    await setTextValue(comment, "c".repeat(12_001));
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(true);
    expect(buttonByText(rendered.container, "却下する").disabled).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(0);
  });

  it("全statusの回答・provenance・解決・取消を編集不可で表示し固定対象を折り返す", async () => {
    const fullHash = "f".repeat(64);
    const answered = requestRow({
      id: "hd_answered",
      status: "answered",
      answerRevision: 1,
      answer: { kind: "approval", outcome: "approve" },
      answerComment: "人間が入力した\nコメント",
      answerProvenance: ANSWER_PROVENANCE,
      answeredAt: 1_800_000_000,
      targetRevision: { kind: "git_commit", value: fullHash },
    });
    const onOpenTask = vi.fn();
    const rendered = await renderCard(propsFor(answered, { onOpenTask }));
    expect(rendered.container.textContent).toContain("回答済み・受領待ち");
    expect(rendered.container.textContent).toContain("回答: 承認する");
    expect(rendered.container.textContent).toContain("人間が入力した\nコメント");
    expect(rendered.container.textContent).toContain("回答日時:");
    expect(rendered.container.textContent).toContain("回答元（ローカル申告）: local-human-claim");
    expect(rendered.container.textContent).toContain(`git_commit: ${fullHash}`);
    expect(rendered.container.textContent).toContain("productionへ公開する");
    expect(rendered.container.textContent).toContain(BASE_REQUEST.question);
    expect(Array.from(rendered.container.querySelectorAll(".break-all"))
      .some((element) => element.textContent?.includes(fullHash))).toBe(true);
    expect(rendered.container.querySelector("textarea, select")).toBeNull();
    await click(buttonByText(rendered.container, answered.taskId));
    expect(onOpenTask).toHaveBeenCalledWith(answered.taskId);

    const claimed = {
      ...answered,
      status: "claimed" as const,
      claimantOrchestratorId: "os_claimant",
      claimantSessionId: "os_session_claimant",
      claimantGeneration: 8,
      claimLeaseUntil: 1_900_000_000,
    };
    await rendered.rerender(propsFor(claimed));
    expect(rendered.container.textContent).toContain("受領済み・未解決");
    expect(rendered.container.textContent).toContain("os_session_claimant");
    expect(rendered.container.querySelector("textarea, select")).toBeNull();

    const resolved = {
      ...answered,
      status: "resolved" as const,
      resolution: { outcome: "obsolete" as const, reason: "新しい依頼で訂正済み" },
      resolvedAt: 1_900_000_001,
    };
    await rendered.rerender(propsFor(resolved));
    expect(rendered.container.textContent).toContain("解決済み");
    expect(rendered.container.textContent).toContain("新しい依頼で訂正済み");
    expect(rendered.container.querySelector("textarea, select")).toBeNull();

    const cancelled = requestRow({
      id: "hd_cancelled",
      status: "cancelled",
      cancelReason: "依頼元が取り消しました",
      cancelledAt: 1_900_000_002,
    });
    await rendered.rerender(propsFor(cancelled));
    expect(rendered.container.textContent).toContain("取消済み");
    expect(rendered.container.textContent).toContain("依頼元が取り消しました");
    expect(rendered.container.querySelector("textarea, select")).toBeNull();
  });

  it("送信中・不明・拒否をsubmissionに従って表示し、同一回答再送と失敗catchを限定する", async () => {
    const onSubmit = vi.fn(async () => undefined);
    const onRetry = vi.fn(async () => undefined);
    const rendered = await renderCard(propsFor(BASE_REQUEST, {
      onSubmit,
      onRetry,
      submission: submissionState({ phase: "submitting", canSubmit: false }),
    }));
    expect(rendered.container.textContent).toContain("送信中");
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(true);

    await rendered.rerender(propsFor(BASE_REQUEST, {
      onSubmit,
      onRetry,
      submission: submissionState({
        phase: "uncertain",
        error: "network unavailable",
        canSubmit: false,
        canRetry: true,
        pendingAnswer: {
          answer: { kind: "approval", outcome: "reject" },
          comment: "このまま再送",
        },
      }),
    }));
    expect(rendered.container.textContent).toContain("保留中の回答: 却下する");
    expect(rendered.container.textContent).toContain("保留中のコメント: このまま再送");
    expect(rendered.container.textContent).toContain("送信結果を確認できません。同じ回答を再送できます");
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(true);
    await click(buttonByText(rendered.container, "同じ回答を再送"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(BASE_REQUEST.id);
    expect(onSubmit).toHaveBeenCalledTimes(0);

    await rendered.rerender(propsFor(BASE_REQUEST, {
      onSubmit,
      onRetry,
      submission: submissionState({
        phase: "rejected",
        error: "revision conflict",
        canSubmit: false,
      }),
    }));
    expect(rendered.container.textContent).toContain("回答は受け付けられませんでした: revision conflict");
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(true);
    await rendered.rerender(propsFor(BASE_REQUEST, {
      onSubmit,
      onRetry,
      submission: submissionState({
        phase: "rejected",
        error: "revision conflict",
        canSubmit: true,
      }),
    }));
    expect(buttonByText(rendered.container, "承認する").disabled).toBe(false);

    const failingSubmit = vi.fn(async () => {
      throw new Error("unexpected callback failure");
    });
    await rendered.rerender(propsFor({ ...BASE_REQUEST, id: "hd_callback_failure" }, {
      onSubmit: failingSubmit,
    }));
    await click(buttonByText(rendered.container, "承認する"));
    await settle();
    expect(rendered.container.textContent).toContain("回答の送信に失敗しました: unexpected callback failure");
  });

  it("typed参照を安全に表示し、添付は明示HEADだけを1件実行して失敗時だけ再確認する", async () => {
    const head = deferred<Response>();
    const fetchMock = vi.fn(() => head.promise);
    vi.stubGlobal("fetch", fetchMock);
    const onOpenTask = vi.fn();
    const request = requestRow({
      id: "hd_links",
      taskId: "t_task with space",
      links: [
        { type: "url", label: "安全なURL", url: "https://example.test/evidence?q=1" },
        { type: "url", label: "危険なURL", url: "https://user:pass@example.test/private" },
        { type: "task", label: "関連タスク", taskId: "t_related" },
        { type: "artifact", label: "画面証跡", artifactName: "wide view.png" },
        { type: "artifact", label: "不正添付", artifactName: "../secret.txt" },
      ],
    });
    const rendered = await renderCard(propsFor(request, { onOpenTask }));
    expect(fetchMock).toHaveBeenCalledTimes(0);
    const external = rendered.container.querySelector<HTMLAnchorElement>('a[href^="https://example.test"]');
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener noreferrer");
    expect(rendered.container.textContent).toContain("参照URLが不正です");
    expect(rendered.container.textContent).toContain("添付名が不正です");
    await click(buttonByText(rendered.container, "t_related"));
    expect(onOpenTask).toHaveBeenCalledWith("t_related");

    const checkButton = buttonByText(rendered.container, "添付を確認");
    await act(async () => {
      checkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      checkButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/task/t_task%20with%20space/artifact/wide%20view.png",
      { method: "HEAD", credentials: "same-origin" },
    );
    await act(async () => {
      head.resolve(new Response(null, { status: 200 }));
      await head.promise;
    });
    const artifact = Array.from(rendered.container.querySelectorAll("a"))
      .find((anchor) => anchor.textContent?.trim() === "添付を開く");
    expect(artifact?.getAttribute("href")).toBe("/task/t_task%20with%20space/artifact/wide%20view.png");

    const failedRequest = requestRow({
      id: "hd_failed_artifact",
      links: [{ type: "artifact", label: "404証跡", artifactName: "missing.png" }],
    });
    const failedResponses = [
      () => Promise.resolve(new Response(null, { status: 404 })),
      () => Promise.reject(new TypeError("network")),
    ];
    fetchMock.mockImplementation(() => (
      failedResponses.shift() ?? (() => Promise.reject(new Error("fixture不足")))
    )());
    await rendered.rerender(propsFor(failedRequest));
    await click(buttonByText(rendered.container, "添付を確認"));
    await settle();
    expect(rendered.container.textContent).toContain("添付を取得できません");
    await click(buttonByText(rendered.container, "添付を再確認"));
    await settle();
    expect(rendered.container.textContent).toContain("添付を取得できません");
  });

  it("request変更とunmount後は遅い旧HEAD completionを反映しない", async () => {
    const oldHead = deferred<Response>();
    const fetchMock = vi.fn(() => oldHead.promise);
    vi.stubGlobal("fetch", fetchMock);
    const oldRequest = requestRow({
      id: "hd_old_head",
      links: [{ type: "artifact", label: "旧添付", artifactName: "old.png" }],
    });
    const rendered = await renderCard(propsFor(oldRequest));
    await click(buttonByText(rendered.container, "添付を確認"));

    const newRequest = requestRow({
      id: "hd_new_head",
      links: [{ type: "artifact", label: "新添付", artifactName: "new.png" }],
    });
    await rendered.rerender(propsFor(newRequest));
    await act(async () => {
      oldHead.resolve(new Response(null, { status: 200 }));
      await oldHead.promise;
    });
    expect(rendered.container.textContent).toContain("新添付");
    expect(rendered.container.textContent).not.toContain("添付を開く");
    expect(buttonByText(rendered.container, "添付を確認")).toBeTruthy();

    const unmountHead = deferred<Response>();
    fetchMock.mockImplementation(() => unmountHead.promise);
    await click(buttonByText(rendered.container, "添付を確認"));
    mountedRoots.delete(rendered.root);
    await act(async () => rendered.root.unmount());
    await act(async () => {
      unmountHead.resolve(new Response(null, { status: 200 }));
      await unmountHead.promise;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
