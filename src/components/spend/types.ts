/** The spend API's JSON as the client reads it (src/app/api/spend/*). */

export type SpendItemStatus = 'ready' | 'review' | 'rejected' | 'no_entry' | 'booked'

export type SpendKind =
  | 'card_purchase'
  | 'card_invoice'
  | 'fee'
  | 'refund'
  | 'chargeback'
  | 'cashback'
  | 'out_of_pocket'
  | 'mileage'
  | 'per_diem'
  | 'reimbursement'
  | 'external_reimbursement'
  | 'wallet_topup'
  | 'wallet_unload'
  | 'atm_withdrawal'
  | 'personal_spend'
  | 'invoice'
  | 'invoice_payment'
  | 'balance_adjustment'
  | 'other'

export interface SpendReasonJson {
  code: string
  params: Record<string, string | number>
  message?: string
}

export interface SpendItemJson {
  id: string
  connection_id: string
  provider: string
  external_id: string
  kind: SpendKind
  expense_date: string
  currency: string
  amount: number
  merchant_name: string | null
  person_name: string | null
  status: SpendItemStatus
  reasons: SpendReasonJson[]
  raw_sha256: string
  document_ids: string[]
  received_at: string
  ack_outcome: 'received' | 'rejected' | null
  changed_after_booking: boolean
  journal_entry_id: string | null
  booked_at: string | null
}

export interface SpendSettingsJson {
  wallet_account: string | null
  out_of_pocket_account: string
}

export interface SpendConnectionJson {
  id: string
  provider: string
  provider_name: string
  mode: 'oauth' | 'api_key'
  provider_company_name: string | null
  provider_org_number: string | null
  status: 'connecting' | 'active' | 'disconnected'
  health: 'ok' | 'degraded' | 'action_required'
  health_code: string | null
  last_success_at: string | null
  next_run_at: string
  master_data_sent_at: string | null
  resolved_settings: SpendSettingsJson
  created_at: string
  ended_at: string | null
}

export interface SpendProviderJson {
  ref: string
  displayName: string
  legalName: string | null
  portalUrl: string | null
  supportUrl: string | null
  connectModes: Array<'oauth' | 'api_key'>
  maxDimensions: number
  setupNoteSv: string | null
}

export interface SpendProposalLineJson {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description?: string
}

export interface SpendExpenseLineJson {
  account: string | null
  amount: number
  vat: { code: string | null; type: 'standard' | 'reverse'; rate: number; amount: number | null } | null
  dimensions: Record<string, string>
  description: string | null
}

export interface SpendItemDetailJson {
  item: SpendItemJson & {
    expense: {
      lines: SpendExpenseLineJson[]
      merchant: { name: string; country: string | null } | null
      person: { name: string } | null
      note: string | null
      attendees: Array<{ name: string; company: string | null; internal: boolean }>
      reference: string | null
      providerUrl: string | null
      original: { currency: string; amount: number } | null
    }
  }
  connection: { id: string; provider: string; provider_name: string; status: string; settings: SpendSettingsJson }
  description: string
  proposal: { lines: SpendProposalLineJson[] }
  reasons: SpendReasonJson[]
}
