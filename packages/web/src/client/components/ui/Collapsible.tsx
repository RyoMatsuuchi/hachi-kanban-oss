// =============================================================================
// shadcn/ui の collapsible パターンをベースにした Radix Collapsible。
// =============================================================================

import type { ComponentPropsWithoutRef, JSX } from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";

export type CollapsibleProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>;
export type CollapsibleTriggerProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>;
export type CollapsibleContentProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>;

export function Collapsible(props: CollapsibleProps): JSX.Element {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

export function CollapsibleTrigger(props: CollapsibleTriggerProps): JSX.Element {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

export function CollapsibleContent(props: CollapsibleContentProps): JSX.Element {
  return <CollapsiblePrimitive.Content data-slot="collapsible-content" {...props} />;
}
