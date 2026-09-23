/**
 * Bokslutsbilagor: the pärm a redovisningskonsult keeps per räkenskapsår
 * (Reko 140/760/765). One bilaga per balance account as of the balansdag:
 * the booked balance and how it moved, what it was reconciled against, who
 * signed it and when, and the underlag files with their content hashes. The
 * checklist rides along as the first page. Types live apart from the
 * generator so the report view does not pull the PDF renderer into the
 * client bundle.
 */

import type { ChecklistState } from '@/lib/bokslut/checklist'

export interface BilagaSignoff {
  id: string
  through_date: string
  /** True when through_date is the balansdag; false when the latest sign-off ends earlier or later. */
  on_balansdag: boolean
  external_balance: number | null
  ledger_balance: number | null
  unexplained_difference: number | null
  note: string | null
  signed_by: string
  signed_by_label: string
  signed_at: string
}

export interface BilagaAttachment {
  id: string
  through_date: string
  file_name: string
  mime_type: string
  size_bytes: number
  sha256: string
  note: string | null
  uploaded_by_label: string
  uploaded_at: string
  removed_at: string | null
  removed_reason: string | null
}

export interface BilagaAccount {
  account_key: string
  kind: 'bank' | 'skattekonto' | 'manual'
  account_number: string
  name: string
  /** From the trial balance through the balansdag; null when the account has no row in the period. */
  opening_balance: number | null
  movement: number | null
  closing_balance: number | null
  /** What the account was reconciled against: system specification, stated balance, or the feed's balance at sign-off. */
  external_label_sv: string
  external_label_en: string
  external_balance: number | null
  difference: number | null
  signoff: BilagaSignoff | null
  attachments: BilagaAttachment[]
}

export interface BilagaChecklistItem {
  key: string
  group: string
  label_sv: string
  label_en: string
  state: ChecklistState
  done_at: string | null
  done_by_label: string | null
  note: string | null
}

export interface BokslutsbilagorReport {
  company: { name: string; org_number: string | null }
  period: { id: string; name: string; start: string; end: string }
  generated_at: string
  app_version: string | null
  checklist: {
    items: BilagaChecklistItem[]
    summary: { total: number; done: number; not_applicable: number; open: number }
  }
  accounts: BilagaAccount[]
  summary: {
    accounts: number
    signed_on_balansdag: number
    signed_other_date: number
    unsigned: number
    attachments: number
  }
}
