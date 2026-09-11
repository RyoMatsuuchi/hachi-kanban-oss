// =============================================================================
// Radix Select（@radix-ui/react-select）をセマンティックトークンでスタイリングした
// 再利用可能な Select コンポーネント（docs/contract.md §20 実装指示）。
// =============================================================================

import type { JSX } from "react";
import * as Select from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon } from "./icons.js";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
}

export function SelectField(props: SelectFieldProps): JSX.Element {
  const { label, value, options, onValueChange } = props;

  return (
    <div className="flex min-w-[9rem] max-w-full flex-col gap-1">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      <Select.Root value={value} onValueChange={onValueChange}>
        <Select.Trigger
          aria-label={label}
          className="inline-flex min-h-10 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Select.Value className="min-w-0 truncate text-left" />
          <Select.Icon>
            <ChevronDownIcon className="h-4 w-4 text-ink-muted" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-50 max-h-72 overflow-hidden rounded-md border border-line bg-surface"
          >
            <Select.Viewport className="p-1">
              {options.map((option) => (
                <Select.Item
                  key={option.value}
                  value={option.value}
                  className="relative flex cursor-pointer select-none items-center rounded-md py-2 pl-7 pr-3 text-sm text-ink outline-none data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent-strong"
                >
                  <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                    <CheckIcon className="h-3.5 w-3.5 text-accent-strong" />
                  </Select.ItemIndicator>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
