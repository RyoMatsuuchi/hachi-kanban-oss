// =============================================================================
// mutation CLI 共通 actor provenance parser（docs/contract.md §60.4）
// =============================================================================

import { Command, InvalidArgumentError, Option } from "commander";
import type { ActorProvenance } from "@hachi/core";

export interface ActorPrincipalOptions {
  actorKind?: "human" | "orchestrator";
  orchestrator?: string;
  session?: string;
  generation?: number;
}

function parsePositiveGeneration(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidArgumentError(`--generation は正の整数が必須です: ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InvalidArgumentError(`--generation は安全な正の整数が必須です: ${value}`);
  }
  return parsed;
}

/** service/unknown を選択肢へ公開せず、対象 mutation に共通 principal flags を追加する。 */
export function addActorPrincipalOptions(command: Command): Command {
  return command
    .addOption(new Option("--actor-kind <kind>", "構造化操作主体").choices(["human", "orchestrator"]))
    .option("--orchestrator <identity-id>", "stable orchestrator identity")
    .option("--session <session-id>", "active orchestrator session")
    .option("--generation <n>", "active session generation", parsePositiveGeneration);
}

/**
 * flag 無指定は legacy unknown。parser 結果は authority ではなく、Store transaction が
 * orchestrator session generation を再照合する。
 */
export function resolveActorProvenance(
  options: ActorPrincipalOptions,
  displayActor: string,
): ActorProvenance | undefined {
  const hasOrchestratorFields =
    options.orchestrator !== undefined || options.session !== undefined || options.generation !== undefined;
  if (options.actorKind === undefined) {
    if (hasOrchestratorFields) {
      throw new Error("--orchestrator/--session/--generation は --actor-kind orchestrator と併用してください");
    }
    return undefined;
  }
  if (options.actorKind === "human") {
    if (hasOrchestratorFields) {
      throw new Error("--actor-kind human は orchestrator/session/generation flags と併用できません");
    }
    return { kind: "human", actorId: displayActor, actorSessionId: "", actorGeneration: null };
  }
  if (options.orchestrator === undefined || options.orchestrator.trim() === "" ||
      options.session === undefined || options.session.trim() === "" || options.generation === undefined) {
    throw new Error(
      "--actor-kind orchestrator は --orchestrator/--session/--generation をすべて必要とします",
    );
  }
  return {
    kind: "orchestrator",
    actorId: options.orchestrator,
    actorSessionId: options.session,
    actorGeneration: options.generation,
  };
}
