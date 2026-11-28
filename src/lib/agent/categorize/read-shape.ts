import type { AccountCandidate } from './select-account'
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { underlagKeyFor } from '@/lib/transactions/underlag-key'
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
  /**
   * Which reverse-charge purchase the read says it is (the basis box, ruta
   * 21 or 22). Null on any other treatment, on a reverse charge taken from
   * a candidate's history, and on reads stored before it was kept: those
   * book as an EU service, the engine's default.
   */
  reverse_charge_kind?: ReverseChargeKind | null
  confidence: number
  model_confidence: string | null
  agreement: number | null
  from_candidate: boolean
  reasoning: string
  candidates: AccountCandidate[]
  model: string | null
  /** Which prompt produced the read (select-account's promptSha256); null on reads stored before it was kept. */
  prompt_sha256?: string | null
  updated_at?: string
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

/**
 * Whether the read picked a candidate whose moms is unknown (vatUnknown) and
 * read nothing in its place (no reverse charge, no purchase abroad): its null
 * treatment is no reading of none. Such a pick books through a review with
 * the underlag's moms (withUnknownVat), never as exempt.
 */
export function readLeavesMomsUnknown(
  read: Pick<AssistantRead, 'account' | 'from_candidate' | 'vat_treatment' | 'candidates'>,
): boolean {
  if (!read.account || !read.from_candidate || read.vat_treatment != null) return false
  return read.candidates.find((c) => c.account === read.account)?.vatUnknown === true
}
