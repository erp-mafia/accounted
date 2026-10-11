/** The POS sales API's JSON as the client reads it (src/app/api/pos-sales/*). */

export type PosTenderKind = 'card' | 'swish' | 'cash' | 'gift_card' | 'invoice' | 'prepaid' | 'other'

export interface PosReviewReasonJson {
  code: 'tender_unmapped' | 'vat_rate_unmapped' | 'not_balanced' | 'payments_without_sales' | 'provider_issue'
  params: Record<string, string | number>
  message?: string
}

export interface PosTenderJson {
  kind: PosTenderKind
  method: string
  amount: number
  tips: number
  receiptCount: number
}

export interface PosVatGroupJson {
  ratePercent: number
  net: number
  vat: number
  gross: number
}

export interface PosDayJson {
  id: string
  connection_id: string
  business_date: string
  currency: string
  status: 'ready' | 'needs_review' | 'empty' | 'booked'
  review_reasons: PosReviewReasonJson[]
  gross: number
  net: number
  vat: number
  tips: number
  receipt_count: number
  tenders: PosTenderJson[]
  vat_groups: PosVatGroupJson[]
  raw_sha256: string
  fetched_at: string
  changed_after_booking: boolean
  journal_entry_id: string | null
  booked_at: string | null
}

export interface PosSettingsJson {
  tender_accounts: Record<PosTenderKind, string | null>
  revenue_accounts: Record<'25' | '12' | '6' | '0', string | null>
  vat_accounts: Record<'25' | '12' | '6', string | null>
  tips_account: string
  rounding_account: string
  max_rounding: number
}

export interface PosConnectionJson {
  id: string
  provider: string
  provider_name: string
  venue_ref: string
  venue_name: string
  status: 'connecting' | 'needs_setup' | 'active' | 'disconnected'
  health: 'ok' | 'degraded' | 'action_required'
  health_code: string | null
  sync_from: string
  synced_through: string | null
  last_success_at: string | null
  next_run_at: string
  resolved_settings: PosSettingsJson
  created_at: string
  ended_at: string | null
}

export interface PosProposalLineJson {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

export interface PosDayDetailJson {
  day: PosDayJson & {
    day: {
      receiptCount: number
      firstReceiptNumber: string | null
      lastReceiptNumber: string | null
      discounts: number
      refunds: { count: number; gross: number }
    }
  }
  connection: { id: string; provider: string; provider_name: string; venue_ref: string; venue_name: string; status: string }
  description: string
  proposal: { lines: PosProposalLineJson[]; rounding_amount: number }
  reasons: PosReviewReasonJson[]
  acknowledgeable: boolean
}

/** The amount a day received through one tender kind (several methods can share a kind). */
export function tenderAmount(day: Pick<PosDayJson, 'tenders'>, kind: PosTenderKind): number {
  return day.tenders.filter((t) => t.kind === kind).reduce((sum, t) => sum + t.amount, 0)
}
