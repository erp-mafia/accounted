import type { AccountCandidate } from './select-account'
import type { Transaction, TransactionCategory, VatTreatment } from '@/types'

/**
 * The stored shape of the assistant's read and the pure helpers on it.
 * Client-safe: no database, no model. The server half is ./read.ts.
 */
export interface AssistantRead {
  transaction_id: string
  underlag_key: string | null
  has_underlag: boolean
  account: string | null
  category: TransactionCategory | null
  vat_treatment: VatTreatment | null
  reverse_charge: boolean
  confidence: number
  model_confidence: string | null
  agreement: number | null
  from_candidate: boolean
  reasoning: string
  candidates: AccountCandidate[]
  model: string | null
  updated_at?: string
}

export function underlagKeyFor(tx: Pick<Transaction, 'document_id'>): string | null {
  return tx.document_id ?? null
}

/** A read is fresh while the transaction still has the document it was read with. */
export function readIsFresh(read: Pick<AssistantRead, 'underlag_key'>, tx: Pick<Transaction, 'document_id'>): boolean {
  return (read.underlag_key ?? null) === underlagKeyFor(tx)
}

/** The first sentence of the model's reasoning; the rest waits behind "Mer". */
export function firstSentence(text: string): string {
  const m = text.trim().match(/^.*?[.!?](?=\s|$)/)
  return m ? m[0] : text.trim()
}
