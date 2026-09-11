// =============================================================================
// shadcn/ui の scroll-area パターンをベースにした Radix ScrollArea。
// ネイティブスクロールは Viewport に残し、細身の overlay scrollbar だけを Radix 側で描画する。
// =============================================================================

import type { ComponentPropsWithoutRef, JSX } from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

type ScrollAreaRootProps = ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>;
type ScrollAreaViewportProps = ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>;
type ScrollAreaScrollbarProps = ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Scrollbar>;

export type ScrollAreaScrollbars = "vertical" | "horizontal" | "both" | "none";

export interface ScrollAreaProps extends ScrollAreaRootProps {
  scrollbars?: ScrollAreaScrollbars;
  /** Radix Viewport 直下の内側ラッパを親幅に収める。横スクロール用途では指定しない。 */
  fitWidth?: boolean;
  viewportClassName?: string;
  viewportProps?: Omit<ScrollAreaViewportProps, "children" | "className">;
}

export type ScrollBarProps = ScrollAreaScrollbarProps;

function joinClassNames(...classNames: Array<string | undefined | false>): string {
  return classNames
    .filter((className): className is string => typeof className === "string" && className !== "")
    .join(" ");
}

function renderScrollBars(scrollbars: ScrollAreaScrollbars): JSX.Element | null {
  switch (scrollbars) {
    case "vertical":
      return <ScrollBar orientation="vertical" />;
    case "horizontal":
      return <ScrollBar orientation="horizontal" />;
    case "both":
      return (
        <>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
        </>
      );
    case "none":
      return null;
  }
}

export function ScrollArea(props: ScrollAreaProps): JSX.Element {
  const {
    children,
    className,
    scrollbars = "vertical",
    scrollHideDelay = 450,
    type = "hover",
    fitWidth = false,
    viewportClassName,
    viewportProps,
    ...rootProps
  } = props;

  return (
    <ScrollAreaPrimitive.Root
      className={joinClassNames("relative flex flex-col overflow-hidden", className)}
      data-slot="scroll-area"
      scrollHideDelay={scrollHideDelay}
      type={type}
      {...rootProps}
    >
      <ScrollAreaPrimitive.Viewport
        className={joinClassNames(
          "min-h-0 w-full flex-auto rounded-[inherit]",
          fitWidth && "[&>div]:!block [&>div]:!w-full [&>div]:!min-w-0",
          viewportClassName,
        )}
        data-slot="scroll-area-viewport"
        {...viewportProps}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {renderScrollBars(scrollbars)}
      <ScrollAreaPrimitive.Corner className="bg-line/40" />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar(props: ScrollBarProps): JSX.Element {
  const { className, orientation = "vertical", ...scrollbarProps } = props;

  return (
    <ScrollAreaPrimitive.Scrollbar
      className={joinClassNames(
        "flex touch-none select-none rounded-full p-0.5 transition-colors data-[state=hidden]:bg-transparent data-[state=visible]:bg-line/40",
        orientation === "vertical"
          ? "h-full w-2 border-l border-l-transparent"
          : "h-2 flex-col border-t border-t-transparent",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...scrollbarProps}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-ink-muted/45 transition-colors before:absolute before:left-1/2 before:top-1/2 before:min-h-10 before:min-w-10 before:-translate-x-1/2 before:-translate-y-1/2 hover:bg-ink-muted/65"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
