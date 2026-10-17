import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import type { BusinessEventCategory } from './categories'
import type { BusinessEventEvidence } from './evidence'
import type { BusinessEventKind } from './kinds'

/**
 * The port's write: the business_events row, before the engine drafts
 * anything (migration 20261016220000_business_events.sql). The link to the
 * draft is the engine's write (lib/bookkeeping/business-event-link.ts), so
 * the kernel never imports this module.
 */

export {
  isMissingTableError,
  type BusinessEventEntryRole,
  type BusinessEventLink,
} from '@/lib/bookkeeping/business-event-link'

/** The party types business_events_party_type_check accepts: a type and an id, never a name. */
export type BusinessEventPartyType = 'customer' | 'supplier' | 'employee' | 'party'

/** One tax amount of an event, in SEK. */
export interface BusinessEventTaxAmount {
  tax: 'vat'
  /** The treatment the producer booked under (standard_25, reverse_charge, ...), when it knows it. */
  treatment: string | null
  /** The tax the business line does not carry: deductible or payable, never negative. */
  amount_sek: number
}

/** A business_events row as the port writes it. */
export interface BusinessEventRow {
  id: string
  company_id: string
  kind: BusinessEventKind
  category: BusinessEventCategory | null
  occurred_on: string
  subject_type: string | null
  subject_id: string | null
  party_type: BusinessEventPartyType | null
  party_id: string | null
  currency: string | null
  amount: number | null
  amount_sek: number | null
  tax_amounts: BusinessEventTaxAmount[]
  evidence: BusinessEventEvidence
  receipt_id: string | null
  pending_operation_id: string | null
  actor_type: string | null
  actor_label: string | null
  mapping_version: string | null
  jurisdiction: string
  idempotency_key: string | null
}

interface DbError {
  code?: string
  message?: string
}

export type RecordBusinessEventResult =
  | { status: 'recorded'; id: string }
  | { status: 'missing_table' }

/**
 * Write the event. Idempotent: the id is made before the write, so a retried
 * write of the same row answers the row already there (unique violation on
 * the id), and an event with an idempotency key already recorded answers
 * that event's id. Throws on any other failure: the port decides by mode
 * whether that stops the posting.
 */
export async function recordBusinessEvent(
  supabase: SupabaseClient,
  row: BusinessEventRow,
): Promise<RecordBusinessEventResult> {
  // Every column spelled out, so the schema guard checks each one.
  const { error } = await supabase.from('business_events').insert({
    id: row.id,
    company_id: row.company_id,
    kind: row.kind,
    category: row.category,
    occurred_on: row.occurred_on,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    party_type: row.party_type,
    party_id: row.party_id,
    currency: row.currency,
    amount: row.amount,
    amount_sek: row.amount_sek,
    tax_amounts: row.tax_amounts,
    evidence: row.evidence,
    receipt_id: row.receipt_id,
    pending_operation_id: row.pending_operation_id,
    actor_type: row.actor_type,
    actor_label: row.actor_label,
    mapping_version: row.mapping_version,
    jurisdiction: row.jurisdiction,
    idempotency_key: row.idempotency_key,
  })
  if (!error) return { status: 'recorded', id: row.id }
  if (isMissingTableError(error)) return { status: 'missing_table' }
  if (error.code === '23505') {
    if (row.idempotency_key) {
      const { data, error: readError } = await supabase
        .from('business_events')
        .select('id')
        .eq('company_id', row.company_id)
        .eq('idempotency_key', row.idempotency_key)
        .maybeSingle()
      if (readError) throw new BusinessEventWriteError(readError)
      if (data) return { status: 'recorded', id: (data as { id: string }).id }
    }
    return { status: 'recorded', id: row.id }
  }
  throw new BusinessEventWriteError(error)
}

/** A business event write the database refused. */
export class BusinessEventWriteError extends Error {
  readonly pgCode?: string
  constructor(error: DbError) {
    super(`business event record failed: ${error.message ?? 'unknown error'}`)
    this.name = 'BusinessEventWriteError'
    this.pgCode = error.code
  }
}
