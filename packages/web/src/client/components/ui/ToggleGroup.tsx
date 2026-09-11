// =============================================================================
// shadcn/ui の toggle-group パターンをベースにした Radix ToggleGroup。
// =============================================================================

import type { ComponentPropsWithoutRef, JSX } from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

export type ToggleGroupProps = ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>;
export type ToggleGroupItemProps = ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>;

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className) => className !== undefined && className !== "").join(" ");
}

export function ToggleGroup(props: ToggleGroupProps): JSX.Element {
  const { className, ...rootProps } = props;
  return (
    <ToggleGroupPrimitive.Root
      className={joinClassNames(
        "inline-flex max-w-full items-center rounded-md border border-line bg-surface-muted p-0.5",
        className,
      )}
      data-slot="toggle-group"
      {...rootProps}
    />
  );
}

export function ToggleGroupItem(props: ToggleGroupItemProps): JSX.Element {
  const { className, ...itemProps } = props;
  return (
    <ToggleGroupPrimitive.Item
      className={joinClassNames(
        "inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium text-ink-muted outline-none transition-colors hover:bg-surface hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-strong/40 disabled:pointer-events-none disabled:opacity-50 data-[state=on]:bg-surface data-[state=on]:text-accent-strong data-[state=on]:shadow-sm",
        className,
      )}
      data-slot="toggle-group-item"
      {...itemProps}
    />
  );
}
