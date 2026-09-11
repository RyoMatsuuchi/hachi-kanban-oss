// native communication attempt の lease/process recovery stage（docs/contract.md §68.4/§68.8）。
// dispatching は外部副作用後の可能性があるため Hachi/native 別 routeへ再送せず uncertain に終端化し、
// claimed だけを同じ delivery key の再claim候補へ戻す Core API に委譲する。
import { redactText } from "@hachi/core";
import type { NativeCommunicationStore, Stage, StageDeps, StageResult } from "@hachi/core";
import { SUPERVISOR_ACTOR } from "../constants.js";
import {
  redriveRecordedNativeAttempt,
  SUPERVISOR_SERVICE_PROVENANCE,
  type StageDepsWithNativeReload,
} from "../native-delivery.js";

export const nativeRecoveryStage: Stage = {
  name: "native-recovery",

  async tick(deps: StageDeps, apply: boolean, now: number): Promise<StageResult> {
    const candidate = deps.store as unknown as Partial<NativeCommunicationStore>;
    const recover = candidate.recoverNativeCommunicationAttempts;
    if (typeof recover !== "function") {
      return {
        name: "native-recovery",
        actions: 0,
        skipped: false,
        notes: ["Core native communication recovery API が未実装のため skipしました"],
      };
    }
    if (!apply) {
      return {
        name: "native-recovery",
        actions: 0,
        skipped: false,
        notes: ["dry-run: native communication lease/process recovery予定"],
      };
    }
    const result = recover.call(deps.store, now, SUPERVISOR_ACTOR, SUPERVISOR_SERVICE_PROVENANCE);
    const listRedriveCandidates = candidate.listNativeCommunicationRedriveCandidates ?? candidate.listCommunicationAttempts;
    const attempts = typeof listRedriveCandidates === "function"
      ? listRedriveCandidates.call(deps.store)
      : [];
    let redriven = 0;
    const redriveNotes: string[] = [];
    for (const attempt of attempts) {
      if (attempt.status !== "recorded" || attempt.route !== "codex-app-server") {
        continue;
      }
      try {
        const delivered = await redriveRecordedNativeAttempt(deps as StageDepsWithNativeReload, attempt, now);
        if (delivered === null) {
          continue;
        }
        redriven += 1;
        redriveNotes.push(`${attempt.id}: durable native redrive=${delivered.status}`);
      } catch (error) {
        const detail = redactText(error instanceof Error ? error.message : String(error));
        redriveNotes.push(`${attempt.id}: durable native redrive待機 (${detail})`);
      }
    }
    return {
      name: "native-recovery",
      actions: result.requeuedClaimed + result.uncertainDispatching + redriven,
      skipped: false,
      notes: [
        `claimed再claim候補=${result.requeuedClaimed}`,
        `dispatching uncertain終端=${result.uncertainDispatching}`,
        ...redriveNotes,
      ],
    };
  },
};
