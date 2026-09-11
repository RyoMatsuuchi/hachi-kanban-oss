import type {
  ActorProvenance,
  OrchestratorSuccessorLaunchRow,
} from "./types.js";

export interface UncertainSuccessorFreshObservation {
  tmuxSessionAbsent: boolean | null;
  panePidAbsent: boolean | null;
  processGroupAbsent: boolean | null;
  observedAt: number;
}

export interface FencedCloseUncertainSuccessorConditions {
  statusUncertain: boolean;
  storedStopEvidenceComplete: boolean;
  freshTargetAbsent: boolean;
  callerSessionGenerationActive: boolean;
  sourceSessionHandoffPending: boolean;
}

export interface FencedCloseUncertainSuccessorInput {
  slotId: string;
  expectedRevision: number;
  provenance: ActorProvenance;
  freshObservation: UncertainSuccessorFreshObservation;
  confirm: boolean;
  now?: number;
}

export interface FencedCloseUncertainSuccessorResult {
  launch: OrchestratorSuccessorLaunchRow;
  conditions: FencedCloseUncertainSuccessorConditions;
  applicable: boolean;
  applied: boolean;
}

/** types.ts の凍結契約へ影響させない additive Store 面。 */
export interface OrchestratorSuccessorFencedCloseStore {
  closeUncertainSuccessorLaunchWithOrchestrator(
    input: FencedCloseUncertainSuccessorInput,
  ): FencedCloseUncertainSuccessorResult;
}
