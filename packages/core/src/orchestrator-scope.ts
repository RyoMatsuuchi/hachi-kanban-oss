import type Database from "better-sqlite3";

interface RawOrchestratorScopeBindingRow {
  orchestrator_id: string;
  role: string;
}

interface RawOrchestratorScopeWatchRow {
  id: string;
  orchestrator_id: string;
}

export interface ResolveOrchestratorDeliveryTargetsInput {
  taskId: string | null;
  worktree: string;
  project: string;
}

const DELIVERY_CWD_LINE_REGEX = /^cwd:\s*(\S+)\s*$/m;

/**
 * §69.3 の配送先解決へ渡す worktree を task body の cwd 行から取り出す。
 * watch selector は完全一致で突合するため、trim や realpath 正規化は行わない。
 */
export function extractDeliveryWorktreeFromBody(body: string): string {
  return body.match(DELIVERY_CWD_LINE_REGEX)?.[1] ?? "";
}

/**
 * task binding → watch の順で durable delivery の宛先 identity を解決する
 * （docs/contract.md §55.1 / §69.3）。Store と readonly 面が共有する唯一の判定実装。
 * 返り値は identity → watch ID（binding 由来は null）。
 */
export function resolveOrchestratorDeliveryTargets(
  db: Database.Database,
  input: ResolveOrchestratorDeliveryTargetsInput,
): Map<string, string | null> {
  const targets = new Map<string, string | null>();
  const ownerTaskId = input.taskId;
  if (ownerTaskId !== null) {
    const bindings = db
      .prepare(
        `SELECT orchestrator_id, role FROM task_orchestrator_bindings
         WHERE task_id = ? AND released_at IS NULL
         ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, created_at`,
      )
      .all(ownerTaskId) as RawOrchestratorScopeBindingRow[];
    for (const binding of bindings) {
      if (binding.role !== "observer") {
        targets.set(binding.orchestrator_id, null);
      }
    }
    // observer を含む active binding が1件でもあれば watch へフォールバックしない。
    if (bindings.length === 0) {
      const watches = db
        .prepare(
          `WITH RECURSIVE ancestors(id) AS (
             SELECT ?
             UNION
             SELECT l.parent_id FROM task_links l JOIN ancestors a ON l.child_id = a.id
             WHERE l.link_type = 'subtask'
           )
           SELECT w.id, w.orchestrator_id FROM orchestrator_watches w
           WHERE w.active = 1 AND w.role <> 'observer' AND (
             (w.scope = 'task' AND w.selector = ?) OR
             (w.scope = 'subtree' AND w.selector IN (SELECT id FROM ancestors)) OR
             (w.scope = 'worktree' AND w.selector = ?) OR
             (w.scope = 'project' AND w.selector = ?)
           )
           ORDER BY
             CASE w.scope WHEN 'task' THEN 0 WHEN 'subtree' THEN 1 WHEN 'worktree' THEN 2 ELSE 3 END,
             CASE w.role WHEN 'primary' THEN 0 ELSE 1 END,
             w.priority DESC, w.created_at`,
        )
        .all(ownerTaskId, ownerTaskId, input.worktree, input.project) as RawOrchestratorScopeWatchRow[];
      for (const watch of watches) {
        if (!targets.has(watch.orchestrator_id)) {
          targets.set(watch.orchestrator_id, watch.id);
        }
      }
    }
  } else {
    const watches = db
      .prepare(
        `SELECT id, orchestrator_id FROM orchestrator_watches
         WHERE active = 1 AND role <> 'observer' AND (
           (scope = 'worktree' AND selector = ?) OR
           (scope = 'project' AND selector = ?)
         )
         ORDER BY CASE scope WHEN 'worktree' THEN 0 ELSE 1 END,
                  CASE role WHEN 'primary' THEN 0 ELSE 1 END,
                  priority DESC, created_at`,
      )
      .all(input.worktree, input.project) as RawOrchestratorScopeWatchRow[];
    for (const watch of watches) {
      if (!targets.has(watch.orchestrator_id)) {
        // 同一 identity は scope tier→role→priority の既存順で最初の行を正本にする。
        targets.set(watch.orchestrator_id, watch.id);
      }
    }
  }
  return targets;
}
