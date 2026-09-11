/**
 * §74.2 auto-archive の統合観測ゲート（決定表・pure）。
 *
 * 副作用は一切持たない。git 観測は `steward-archive-integration-probe.ts` の
 * probe が別途行い、その結果を正規化した `ArchiveIntegrationObservation` を
 * ここへ渡すだけにする（§64.2 の done-consistency と同じ形）。
 */

import { INTEGRATION_EVIDENCE_VALUES, type IntegrationEvidence } from "@hachi/core";

export { INTEGRATION_EVIDENCE_VALUES, type IntegrationEvidence };

export type ArchiveIntegrationVerdict = "allow" | "veto";

export interface ArchiveIntegrationDecision {
  verdict: ArchiveIntegrationVerdict;
  integrationEvidence: IntegrationEvidence;
}

/**
 * §74.2.0 cwd 正規化の結果。probe が1回の評価で作る「正規化済みの観測結果」。
 * pure関数はこれだけを入力に取る。
 */
export type CwdNormalization =
  | { kind: "no-cwd" }
  | { kind: "not-a-worktree" }
  | { kind: "repo-root"; dirty: boolean }
  | { kind: "worktree-missing"; underCanonicalRoot: boolean }
  | { kind: "worktree-present" };

/** §74.2.1 統合先 ref の解決結果。union にせず単一候補だけを持つ。 */
export type IntegrationTargetResolution =
  | { state: "unresolved" }
  | { state: "resolved"; ref: string; oid: string };

/** §74.2.2 統合証明の結果。A（ancestor）/ B（patch-equivalent）のいずれかのみ allow を意味する。 */
export type IntegrationProofResult =
  | { kind: "probe-failed" }
  | { kind: "dirty" }
  | { kind: "clean"; proof: "ancestor" } // A成立 → clean-head-reachable
  | { kind: "clean"; proof: "patch-equivalent" } // B成立 → clean-patch-equivalent
  | { kind: "clean"; proof: "none" }; // どちらも不成立 → veto

export interface ArchiveIntegrationObservation {
  cwd: CwdNormalization;
  // worktree-present のときだけ意味を持つ（それ以外は probe 側で undefined のまま渡してよい）
  integrationTarget?: IntegrationTargetResolution;
  integrationProof?: IntegrationProofResult;
  // probe が評価中に pin した値（worktree HEAD OID / 統合先 ref+OID / porcelain の dirty/clean）の
  // いずれかが最終確認時に変化したことを検出した場合 true。true なら他の全フィールドを無視し
  // 行13を返す（判定のどの段階で検出しても即座に veto という契約の要求）。
  drift: boolean;
}

function allow(integrationEvidence: IntegrationEvidence): ArchiveIntegrationDecision {
  return { verdict: "allow", integrationEvidence };
}

function veto(integrationEvidence: IntegrationEvidence): ArchiveIntegrationDecision {
  return { verdict: "veto", integrationEvidence };
}

/**
 * §74.2 決定表の全13行を評価順（表の上から）どおりに実装する。
 * 行13（drift）だけは例外で、判定のどの段階で検出しても即座に veto へ倒すため最優先で見る。
 * allow は行3・4・5・10・11の5行だけであり、それ以外は全て veto である。
 */
export function decideArchiveIntegration(
  observation: ArchiveIntegrationObservation,
): ArchiveIntegrationDecision {
  // 行13: 判定中に pin した HEAD / 統合先 ref / porcelain が変化した。他のフィールドは無視する。
  if (observation.drift) {
    return veto("unobservable:observation-drift");
  }

  const { cwd } = observation;
  switch (cwd.kind) {
    case "no-cwd":
      // 行1: cwd: 行が無い
      return veto("unobservable:no-cwd");

    case "not-a-worktree":
      // 行2: cwd を worktree identity へ正規化できない（非 git / ファイル / bare / 解決失敗）
      return veto("unobservable:cwd-not-a-worktree");

    case "repo-root":
      // 行3: repo root・clean / 行4: repo root・dirty（いずれも allow。porcelain 以外は評価しない）
      return cwd.dirty
        ? allow("not-observable:repo-root-dirty")
        : allow("not-observable:repo-root");

    case "worktree-missing":
      // 行5: 不在かつ canonical worktree root 配下 → allow
      // 行6: 不在かつ canonical worktree root 配下でない → veto（cwd-not-a-worktree と同じ evidence）
      return cwd.underCanonicalRoot
        ? allow("not-observable:worktree-missing")
        : veto("unobservable:cwd-not-a-worktree");

    case "worktree-present": {
      // 統合先 ref の解決中に probe 自体が失敗した場合（§74.2.3.1: symbolic-ref のその他終了等）は、
      // target が未解決のまま残っていても「ref が無かった」(行7)ではなく「観測できなかった」(行8)を
      // 優先する。target 未解決は「解決を試みて綺麗に見つからなかった」ことを意味するため、
      // probe-failed の明示signalがあるときはそちらを先に見る。
      const proof = observation.integrationProof;
      if (proof !== undefined && proof.kind === "probe-failed") {
        // 行8: worktree 存在・probe が失敗 / timeout した（統合先解決フェーズでの失敗を含む）
        return veto("unobservable:probe-failed");
      }

      const target = observation.integrationTarget;
      if (target === undefined || target.state === "unresolved") {
        // 行7: worktree 存在・統合先 ref を1つも解決できない（probeは正常に完走した）
        return veto("unobservable:no-integration-ref");
      }

      if (proof === undefined) {
        // 行8: 統合先は解決できたが、その後の証明計算（HEAD取得・porcelain等）へ到達できなかった
        return veto("unobservable:probe-failed");
      }

      if (proof.kind === "dirty") {
        // 行9: worktree 存在・porcelain 非空（dirty）
        return veto("unintegrated:worktree-dirty");
      }

      // ここから proof.kind === "clean"
      switch (proof.proof) {
        case "ancestor":
          // 行10: clean・§74.2.2 の A（到達可能）が成立
          return allow("clean-head-reachable");
        case "patch-equivalent":
          // 行11: clean・§74.2.2 の B（patch 等価 + 内容一致）が成立
          return allow("clean-patch-equivalent");
        case "none": {
          // 行12: clean・A も B も成立しない
          return veto("unintegrated:branch-commits-not-in-main");
        }
        default: {
          // 網羅性チェックは discriminant プロパティ（proof.proof）ではなく
          // オブジェクト全体（proof）に対して行う。TypeScript コンパイラの版によっては
          // discriminant プロパティ単体への never 割り当てが正しく narrowing されないため、
          // cwd.kind の網羅性チェック（下記）と同じ形に揃える。
          const exhaustive: never = proof;
          throw new Error(
            `未知の integrationProof.proof です: ${String((exhaustive as { proof: string }).proof)}`,
          );
        }
      }
    }

    default: {
      const exhaustive: never = cwd;
      throw new Error(`未知の cwd.kind です: ${String((exhaustive as CwdNormalization).kind)}`);
    }
  }
}
