import type { Transaction, TransactionCategory, Invoice, Customer, SupplierInvoice, VatTreatment } from '@/types'
import type { OpenRotRutPayoutRequest } from '@/lib/invoices/open-rot-rut-payout-requests'
import type { ExpensePayoutDue } from '@/lib/worklist/types'
import type { EmbeddedVoucherLink } from '@/lib/transactions/is-booked'

/** An open ROT/RUT begäran offered to an income row, with the invoices it
 *  covers (so the user sees which fakturor the payout settles). */
export type PotentialRotRutPayoutRequest = OpenRotRutPayoutRequest

/** The ROT/RUT match suggestion hung onto an income row: the begäran
 *  Skatteverkets utbetalning settles. One for a persisted 1:1 hint or a
 *  manual pick; several when the transfer bundles the beslut paid that day
 *  (computed at read time, lib/invoices/rot-rut-payout-set-matching.ts). */
export interface PotentialRotRutPayout {
  requests: PotentialRotRutPayoutRequest[]
}

/** Revalidated journal-entry match suggestion hung onto a row (mirrors
 *  potential_invoice): present only when the suggested entry is still posted. */
export interface PotentialVoucher {
  journal_entry_id: string
  voucher_series: string
  voucher_number: number
  entry_date: string
  description: string | null
}

// Shared transaction type with potential invoice data
export interface TransactionWithInvoice extends Transaction {
  /** Whether a live verifikat books the row, on the reads that name the column. */
  is_booked?: boolean | null
  potential_invoice?: Invoice & { customer?: Customer }
  potential_supplier_invoice?: SupplierInvoice
  potential_rot_rut_payout?: PotentialRotRutPayout
  potential_voucher?: PotentialVoucher
  /** The person whose registered utlägg this outflow repays in full
   *  (lib/expenses/expense-payout-candidates): computed at read time, no
   *  hint column. Present only while their claims are still registered. */
  potential_expense_payout?: ExpensePayoutDue
  /** Junction anchors embedded by the list fetch: a row split over several
   *  verifikat (#1553) or bulk-booked has journal_entry_id NULL and is booked
   *  through these. Read via getLinkedJournalEntryIds, never the pointer alone. */
  transaction_voucher_links?: EmbeddedVoucherLink[] | null
  /** How many parts the row's Bankgirot split has (bank_transaction_parts),
   *  embedded by the list fetch as PostgREST's `[{ count }]`; the parts
   *  themselves come from GET /api/transactions/[id]/parts in the drawer. */
  parts_count?: { count: number }[] | null
}

// Page view modes. 'review' is the migrator surface: rows whose sweep
// suggestion awaits confirmation ("Granska migrerad historik"); the tab only
// renders while such rows exist.
export type ViewMode = 'inbox' | 'history' | 'review'
export type { HistoryFilter } from '@/lib/transactions/history-filter'
// Source filter (concept scene 10 account chooser), shared by both view modes:
// everything, one cash account ('acct:<id>'), bank rows not yet tied to a
// registered cash account ('bank:other'), all bank rows ('bank': the fallback
// split when no cash accounts are registered), or the skattekonto side.
export type SourceFilter = 'all' | 'bank' | 'bank:other' | 'skatteverket' | `acct:${string}`

// Handler types
// Returns the journal_entry_id on success, null on failure
export type CategorizeHandler = (
  id: string,
  isBusiness: boolean,
  category?: TransactionCategory,
  vatTreatment?: VatTreatment,
  accountOverride?: string,
  templateId?: string,
  inboxItemId?: string,
  // Dimensions bag {sie_dim_no: code} for the business lines of the booking.
  dimensions?: Record<string, string>,
  /** The underlag's moms in the transaction's currency; replaces the rate-based VAT line. */
  vatAmount?: number
) => Promise<string | null>

// Category option type. `labelKey` is the next-intl key under the
// `tx_categories` namespace: the label in the user's language.
export interface CategoryOption {
  value: TransactionCategory
  labelKey: string
  account?: string
}

// Shared category arrays
export const EXPENSE_CATEGORIES: CategoryOption[] = [
  { value: 'expense_representation', labelKey: 'expense_representation', account: '6072' },
  { value: 'expense_equipment', labelKey: 'expense_equipment', account: '5410' },
  { value: 'expense_software', labelKey: 'expense_software', account: '5420' },
  { value: 'expense_consumables', labelKey: 'expense_consumables', account: '5460' },
  { value: 'expense_travel', labelKey: 'expense_travel', account: '5800' },
  { value: 'expense_office', labelKey: 'expense_office', account: '6110' },
  { value: 'expense_vehicle', labelKey: 'expense_vehicle', account: '5611' },
  { value: 'expense_telecom', labelKey: 'expense_telecom', account: '6200' },
  { value: 'expense_marketing', labelKey: 'expense_marketing', account: '5910' },
  { value: 'expense_professional_services', labelKey: 'expense_professional_services', account: '6530' },
  { value: 'expense_education', labelKey: 'expense_education', account: '6991' },
  { value: 'expense_bank_fees', labelKey: 'expense_bank_fees', account: '6570' },
  { value: 'expense_card_fees', labelKey: 'expense_card_fees', account: '6570' },
  { value: 'expense_currency_exchange', labelKey: 'expense_currency_exchange', account: '7960' },
  { value: 'expense_other', labelKey: 'expense_other', account: '6991' },
]

export const INCOME_CATEGORIES: CategoryOption[] = [
  { value: 'income_services', labelKey: 'income_services', account: '3001' },
  { value: 'income_products', labelKey: 'income_products', account: '3001' },
  { value: 'income_other', labelKey: 'income_other', account: '3900' },
]

/** A VAT treatment choice; both keys are in the `tx_categories` namespace. */
export interface VatTreatmentOption {
  value: VatTreatment | 'none'
  labelKey: string
  descriptionKey?: string
}

export const VAT_TREATMENT_OPTIONS: VatTreatmentOption[] = [
  { value: 'standard_25', labelKey: 'vat_standard_25' },
  { value: 'reduced_12', labelKey: 'vat_reduced_12', descriptionKey: 'vat_reduced_12_desc' },
  { value: 'reduced_6', labelKey: 'vat_reduced_6', descriptionKey: 'vat_reduced_6_desc' },
  { value: 'reverse_charge', labelKey: 'vat_reverse_charge', descriptionKey: 'vat_reverse_charge_desc' },
  { value: 'export', labelKey: 'vat_export', descriptionKey: 'vat_export_desc' },
  { value: 'exempt', labelKey: 'vat_exempt', descriptionKey: 'vat_exempt_desc' },
  { value: 'none', labelKey: 'vat_none', descriptionKey: 'vat_none_desc' },
]
