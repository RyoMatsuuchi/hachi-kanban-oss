// =============================================================================
// テナントチップ: テナント名をハッシュ安定色のミュートチップとして表示する。
// 空テナントは neutral 色でフォールバックする。
// =============================================================================

import type { CSSProperties, JSX } from "react";
import { tenantHue } from "../lib/tenant-color.js";

export interface TenantChipProps {
  tenant: string;
  className?: string;
}

function chipLabel(tenant: string): string {
  return tenant === "" ? "(no tenant)" : tenant;
}

export function TenantChip(props: TenantChipProps): JSX.Element {
  const { tenant } = props;
  const label = chipLabel(tenant);
  const hue = tenantHue(tenant);

  // 空テナントは neutral 色、それ以外はハッシュ色相でミュートチップ
  const colorClass =
    tenant === "" ? "bg-surface-muted text-ink-muted" : "tenant-chip-hash";
  const style: CSSProperties | undefined =
    tenant === "" ? undefined : ({ "--chip-hue": String(hue) } as CSSProperties);

  return (
    <span
      title={`tenant: ${tenant === "" ? "-" : tenant}`}
      style={style}
      className={`inline-flex max-w-[7rem] shrink-0 items-center rounded-md px-1.5 py-px text-[10px] font-medium leading-none ${colorClass} ${props.className ?? ""}`}
    >
      <span className="min-w-0 truncate">{label}</span>
    </span>
  );
}
