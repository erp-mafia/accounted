import type { JournalEntry } from '@/types'
import type { UnderlagReference } from '@/lib/core/bookkeeping/journal-entry-references'

// Snapshot of a struck line, as stored in journal_entry_rattelse_log.
export type StruckLineSnapshot = {
  id: string
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  line_description: string | null
  sort_order: number
}

export type RattelseLogRow = {
  id: string
  rattelse_type: 'metadata' | 'lines'
  old_description: string | null
  new_description: string | null
  old_entry_date: string | null
  new_entry_date: string | null
  struck_lines: StruckLineSnapshot[] | null
  added_lines: StruckLineSnapshot[] | null
  actor: string | null
  // Resolved server-side from profiles (rattelse-log route); null when the
  // actor is unknown or the lookup failed.
  actor_label: string | null
  created_at: string
  // 'sie_import': correction history carried by the imported SIE file
  // (#BTRANS/#RTRANS); the source system's signature stands in for the actor.
  source?: 'user' | 'sie_import' | null
  external_signature?: string | null
}

export type PeriodStatus = 'open' | 'locked' | 'closed'

export type JournalEntryDetailRead = {
  delete_block?: import('@/lib/core/bookkeeping/voucher-delete-guard').SieDeleteBlock | null
  owned_by?: import('@/lib/core/bookkeeping/voucher-owner').VoucherOwner | null
  period?: Awaited<ReturnType<typeof import('@/lib/core/bookkeeping/period-service').resolvePeriodStatusForDate>> & {filed_vat:import('@/lib/vat/filed-period-for-date').FiledVatPeriod | null} | null
  entry: JournalEntry
  chain: JournalEntry[]
  is_last_in_series: boolean
  references: UnderlagReference[] | null
  rattelse_log: RattelseLogRow[]
  retag_log: {
    id: string; line_id: string; old_dimensions: Record<string, string>
    new_dimensions: Record<string, string>; reason: string; created_at: string
  }[]
  period_status: PeriodStatus | null
}
