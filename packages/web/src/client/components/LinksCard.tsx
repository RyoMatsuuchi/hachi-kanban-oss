// =============================================================================
// 親子リンクと depends-on 依存一覧（docs/contract.md §14.3 / §24.4）。
// =============================================================================

import type { JSX } from "react";
import type { LinkWithTitle, TaskDependency } from "../../shared/api-types.js";
import { Card } from "./Card.js";

const DEPENDS_ON_LINK_TYPE = "depends-on";

/** done/archived は依存ゲート上の充足済み前提として扱う（docs/contract.md §24.1） */
function isDependencyFulfilled(dependency: TaskDependency): boolean {
  return dependency.status === "done" || dependency.status === "archived";
}

function LinkList(props: {
  title: string;
  items: LinkWithTitle[];
  getTaskId: (item: LinkWithTitle) => string;
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const { title, items, getTaskId, onOpenTask } = props;
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm italic text-ink-muted">なし</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.link.id} className="flex min-w-0 items-baseline gap-1.5">
              <button
                type="button"
                onClick={() => onOpenTask(getTaskId(item))}
                title={item.title}
                className="truncate text-sm text-accent-strong hover:underline"
              >
                {item.title}
              </button>
              <span className="shrink-0 text-xs text-ink-muted">（{item.link.linkType}）</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DependencyList(props: {
  title: string;
  items: TaskDependency[];
  onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const { title, items, onOpenTask } = props;
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="text-sm italic text-ink-muted">なし</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => {
            const fulfilled = isDependencyFulfilled(item);
            const dotClassName = fulfilled ? "bg-ok-strong" : "bg-ink-muted";
            const statusLabel = fulfilled ? "充足" : "未充足";
            return (
              <li key={item.id} className="flex min-w-0 items-center gap-2">
                <span
                  title={statusLabel}
                  aria-label={statusLabel}
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClassName}`}
                />
                <button
                  type="button"
                  onClick={() => onOpenTask(item.id)}
                  title={item.title}
                  className="min-w-0 truncate text-left text-sm text-accent-strong hover:underline"
                >
                  {item.title}
                </button>
                <span className="shrink-0 text-xs text-ink-muted">（{item.status}）</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export interface LinksCardProps {
  links: { parents: LinkWithTitle[]; children: LinkWithTitle[] };
  dependencies: TaskDependency[];
  onOpenTask: (taskId: string) => void;
}

export function LinksCard(props: LinksCardProps): JSX.Element {
  const { links, dependencies, onOpenTask } = props;
  const parentLinks = links.parents.filter((item) => item.link.linkType !== DEPENDS_ON_LINK_TYPE);
  const childLinks = links.children.filter((item) => item.link.linkType !== DEPENDS_ON_LINK_TYPE);
  const dependentLinks = links.children.filter((item) => item.link.linkType === DEPENDS_ON_LINK_TYPE);

  return (
    <Card title="リンク">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <DependencyList title="前提タスク" items={dependencies} onOpenTask={onOpenTask} />
        <LinkList
          title="依存先タスク"
          items={dependentLinks}
          getTaskId={(item) => item.link.childId}
          onOpenTask={onOpenTask}
        />
        <LinkList
          title="親タスク"
          items={parentLinks}
          getTaskId={(item) => item.link.parentId}
          onOpenTask={onOpenTask}
        />
        <LinkList
          title="子タスク"
          items={childLinks}
          getTaskId={(item) => item.link.childId}
          onOpenTask={onOpenTask}
        />
      </div>
    </Card>
  );
}
