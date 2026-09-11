// 契約§74.2の共有語彙。値と順序を変更せず、判定・I/Oは各consumerに残す。
export const INTEGRATION_EVIDENCE_VALUES = [
  "unobservable:no-cwd", // 行1
  "unobservable:cwd-not-a-worktree", // 行2, 行6
  "not-observable:repo-root", // 行3
  "not-observable:repo-root-dirty", // 行4
  "not-observable:worktree-missing", // 行5
  "unobservable:no-integration-ref", // 行7
  "unobservable:probe-failed", // 行8
  "unintegrated:worktree-dirty", // 行9
  "clean-head-reachable", // 行10
  "clean-patch-equivalent", // 行11
  "unintegrated:branch-commits-not-in-main", // 行12
  "unobservable:observation-drift", // 行13
] as const;

export type IntegrationEvidence = (typeof INTEGRATION_EVIDENCE_VALUES)[number];

