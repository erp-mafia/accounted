import { Badge, type BadgeProps } from '@/components/ui/badge'

export interface RowStatusDescriptor {
  label: string
  /**
   * True when the row DEVIATES from the normal state (Utkast, Förfallen,
   * Ej bokförd). Normal states render as muted text; a table where every
   * row carries the same chip is wrong (UI-migration convention 5).
   */
  exception?: boolean
  /** Badge variant for exception states. */
  variant?: BadgeProps['variant']
}

/**
 * Chips mark exceptions: renders a status as muted text for normal states
 * and as a Badge only when the row deviates. Pages define their status map
 * as `Record<Status, RowStatusDescriptor>` and pass the resolved entry.
 */
export function RowStatus({ status }: { status: RowStatusDescriptor }) {
  if (status.exception) {
    return <Badge variant={status.variant ?? 'warning'}>{status.label}</Badge>
  }
  return <span className="text-xs text-muted-foreground">{status.label}</span>
}
