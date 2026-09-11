// =============================================================================
// 最小限のインライン SVG アイコン（Radix Select の装飾用）。
// アイコンライブラリの追加依存を避けるため自前で用意する。
// =============================================================================

import type { JSX } from "react";

export interface IconProps {
  className?: string;
}

export function ChevronDownIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M5 7.5L10 12.5L15 7.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M4 10.5L8 14.5L16 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M8.75 14.25C11.7876 14.25 14.25 11.7876 14.25 8.75C14.25 5.71243 11.7876 3.25 8.75 3.25C5.71243 3.25 3.25 5.71243 3.25 8.75C3.25 11.7876 5.71243 14.25 8.75 14.25Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M12.75 12.75L16.5 16.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function StarIcon(props: IconProps & { filled?: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill={props.filled === true ? "currentColor" : "none"} aria-hidden="true" className={props.className}>
      <path
        d="M10 2.8L12.15 7.16L16.96 7.86L13.48 11.25L14.3 16.04L10 13.78L5.7 16.04L6.52 11.25L3.04 7.86L7.85 7.16L10 2.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function FilterIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M3 5H17M5.5 10H14.5M8 15H12"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CalendarIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M6 3.5V6M14 3.5V6M4 8.5H16M5 5H15C15.5523 5 16 5.44772 16 6V16C16 16.5523 15.5523 17 15 17H5C4.44772 17 4 16.5523 4 16V6C4 5.44772 4.44772 5 5 5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function BookIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M5 4.5H9.25C10.2165 4.5 11 5.2835 11 6.25V16C11 15.1716 10.3284 14.5 9.5 14.5H5C4.44772 14.5 4 14.0523 4 13.5V5.5C4 4.94772 4.44772 4.5 5 4.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M15 4.5H12.75C11.7835 4.5 11 5.2835 11 6.25V16C11 15.1716 11.6716 14.5 12.5 14.5H15C15.5523 14.5 16 14.0523 16 13.5V5.5C16 4.94772 15.5523 4.5 15 4.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MetricsIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={props.className}>
      <rect x="1" y="8" width="3" height="6" rx="0.5" fill="currentColor" />
      <rect x="6.5" y="4" width="3" height="10" rx="0.5" fill="currentColor" />
      <rect x="12" y="1" width="3" height="13" rx="0.5" fill="currentColor" />
    </svg>
  );
}

export function UsageIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={props.className}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9.6 6.1c-.3-.5-.9-.8-1.6-.8-1 0-1.7.5-1.7 1.2 0 .7.6 1 1.7 1.2 1.1.2 1.8.5 1.8 1.3 0 .8-.7 1.3-1.8 1.3-.8 0-1.4-.3-1.7-.9M8 4.2v7.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoreIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M5 10H5.01M10 10H10.01M15 10H15.01"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SessionsIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M4 6.5H16M4 10H16M4 13.5H11"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M13.5 13L16 15.5L13.5 18"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className={props.className}>
      <path
        d="M10 7.25C8.48122 7.25 7.25 8.48122 7.25 10C7.25 11.5188 8.48122 12.75 10 12.75C11.5188 12.75 12.75 11.5188 12.75 10C12.75 8.48122 11.5188 7.25 10 7.25Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M10.8 3.25L11.35 4.9C11.48 5.29 11.86 5.53 12.26 5.46L13.98 5.16L14.78 6.54L13.61 7.84C13.34 8.14 13.34 8.6 13.61 8.9L14.78 10.2L13.98 11.58L12.26 11.28C11.86 11.21 11.48 11.45 11.35 11.84L10.8 13.49H9.2L8.65 11.84C8.52 11.45 8.14 11.21 7.74 11.28L6.02 11.58L5.22 10.2L6.39 8.9C6.66 8.6 6.66 8.14 6.39 7.84L5.22 6.54L6.02 5.16L7.74 5.46C8.14 5.53 8.52 5.29 8.65 4.9L9.2 3.25H10.8Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
