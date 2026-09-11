// durable cancel のCLI text formatter（証拠判定/redactionは@hachi/coreを正本とする）。

import type { CancelLifecycleSummary } from "@hachi/core";

function visible(value: string): string {
  return value === "" ? "-" : value;
}

/** plain textでもJSONと同じ監査情報を欠落させない。 */
export function formatCancelSummary(summary: CancelLifecycleSummary): string {
  return [
    [
      `cancel=${summary.status}`,
      `request=${summary.requestId}`,
      `run=${summary.runId}`,
      `session=${summary.sessionId}`,
      `fence=${summary.cancelFence}`,
      `delivered=${summary.delivered}`,
      `observed=${summary.observed}`,
      `acknowledged=${summary.acknowledged}`,
      `stopped=${summary.stopped}`,
    ].join(" "),
    `requester=${visible(summary.orchestratorId)}/${visible(summary.requesterSessionId)} generation=${summary.requesterGeneration ?? "-"} deadline=${summary.deadlineAt}`,
    `reason=${visible(summary.reason)}`,
    `capability=${visible(summary.capabilitySnapshot)}`,
    `stopEvidence=${visible(summary.stopEvidence)}`,
    `lastError=${visible(summary.lastError)}`,
  ].join("\n");
}
