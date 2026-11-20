/**
 * How a record's status shows in the UI, the shape the per-record helpers
 * return (lib/invoices/status-display.ts, lib/supplier-invoices/
 * status-display.ts, lib/salary/run-status-display.ts).
 *
 * Chips mark exceptions: a normal state is muted
 * text (`chip: null`), a deviating one a Badge of the given variant.
 */
export type StatusChip = 'secondary' | 'outline' | 'warning' | 'destructive'

export interface StatusDisplay {
  /** The label's key in the record's own namespace (named by its helper). */
  labelKey: string
  chip: StatusChip | null
}

/**
 * The one colour of "Förfallen", for a customer invoice and a supplier
 * invoice alike: ochre, the attention tone (convention 6), not terracotta,
 * which marks a refusal or a failure (Peppol misslyckades, avslag).
 */
export const OVERDUE_CHIP: StatusChip = 'warning'

/** The text tone of a status written as a word instead of a Badge (the transaction pickers). */
export function statusChipTextClass(chip: StatusChip): string {
  if (chip === 'warning') return 'text-attn'
  if (chip === 'destructive') return 'text-destructive'
  return 'text-muted-foreground'
}
