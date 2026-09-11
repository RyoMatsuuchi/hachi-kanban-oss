// =============================================================================
// orchestrator handover --apply の後継セッション送達ゲート。
// ファイルの存在ではなく、後継 transcript jsonl の user nonce と assistant 行を順に確認する。
// =============================================================================

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findClaudeSessionDir } from "@hachi/adapters";

/** 送達ゲートが1回の観測で得た状態 */
export interface DeliveryGateObservation {
  /** type:user 行の本文に期待した launch nonce が含まれる */
  userNonceObserved: boolean;
  /** nonce 一致 user 行より後に type:assistant 行が現れる */
  assistantObserved: boolean;
}

/** 後継 transcript を読む probe。テストでは実機の claude/tmux を使わず差し替える */
export type HandoverDeliveryGateProbe = (params: {
  claudeProjectsRoot: string;
  successorSessionId: string;
  launchNonce: string;
}) => Promise<DeliveryGateObservation>;

/** message.content の既知2形式から表示テキストだけを取り出す */
function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    }
  }
  return parts.join("");
}

/** jsonl を行順に走査し、nonce 一致後の assistant だけを2段目として数える */
function observeJsonl(logPath: string, launchNonce: string): DeliveryGateObservation {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return { userNonceObserved: false, assistantObserved: false };
  }

  let userNonceObserved = false;
  let assistantObserved = false;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 書込み途中や破損した1行は無視し、次の bounded poll で再観測する。
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record["type"] === "assistant") {
      if (userNonceObserved) {
        assistantObserved = true;
      }
      continue;
    }
    if (record["type"] !== "user") {
      continue;
    }
    const message = record["message"];
    if (message === null || typeof message !== "object") {
      continue;
    }
    const content = (message as Record<string, unknown>)["content"];
    if (extractTextFromMessageContent(content).includes(launchNonce)) {
      userNonceObserved = true;
    }
  }
  return { userNonceObserved, assistantObserved };
}

/** successorSessionId に完全一致する transcript を探して内容を観測する本番 probe */
export const defaultHandoverDeliveryGateProbe: HandoverDeliveryGateProbe = async (params) => {
  const sessionDir = await findClaudeSessionDir(params.claudeProjectsRoot, params.successorSessionId);
  if (sessionDir === null) {
    return { userNonceObserved: false, assistantObserved: false };
  }
  return observeJsonl(join(sessionDir, `${params.successorSessionId}.jsonl`), params.launchNonce);
};

/** cwd が claude の workspace trust dialog を承諾済みか読む probe */
export interface ClaudeTrustProbe {
  isTrusted(cwd: string): boolean;
}

function resolveClaudeConfigJsonPath(): string {
  const configDir = process.env["CLAUDE_CONFIG_DIR"]?.split(",")[0]?.trim();
  if (configDir !== undefined && configDir !== "") {
    return join(configDir, ".claude.json");
  }
  return join(homedir(), ".claude.json");
}

/** 設定読取り失敗・不正 JSON・未登録・false はすべて未信頼へ倒す */
function readClaudeTrustFlag(configPath: string, cwd: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") {
    return false;
  }
  const projects = (parsed as Record<string, unknown>)["projects"];
  if (projects === null || typeof projects !== "object") {
    return false;
  }
  const projectMap = projects as Record<string, unknown>;
  const candidates = new Set<string>([cwd]);
  try {
    candidates.add(realpathSync(cwd));
  } catch {
    // cwd-usable preflight と競合して消えた場合も未信頼へ倒す。
  }
  for (const candidate of candidates) {
    const entry = projectMap[candidate];
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>)["hasTrustDialogAccepted"] === true
    ) {
      return true;
    }
  }
  return false;
}

/** 本番用 trust probe。呼出しごとに環境と設定ファイルを解決する */
export const defaultClaudeTrustProbe: ClaudeTrustProbe = {
  isTrusted(cwd: string): boolean {
    return readClaudeTrustFlag(resolveClaudeConfigJsonPath(), cwd);
  },
};

/** 単体テスト用に設定ファイルの場所を固定する */
export function createClaudeTrustProbeForConfig(configPath: string): ClaudeTrustProbe {
  return {
    isTrusted(cwd: string): boolean {
      return readClaudeTrustFlag(configPath, cwd);
    },
  };
}
