import type { Transaction, TransactionCategory, Invoice, Customer, SupplierInvoice, VatTreatment } from '@/types'

// Shared transaction type with potential invoice data
export interface TransactionWithInvoice extends Transaction {
  potential_invoice?: Invoice & { customer?: Customer }
  potential_supplier_invoice?: SupplierInvoice
}

// Page view modes
export type ViewMode = 'inbox' | 'history'
export type HistoryFilter = 'all' | 'business' | 'private'

// Handler types
// Returns the journal_entry_id on success, null on failure
export type CategorizeHandler = (
  id: string,
  isBusiness: boolean,
  category?: TransactionCategory,
  vatTreatment?: VatTreatment,
  accountOverride?: string,
  templateId?: string,
  inboxItemId?: string
) => Promise<string | null>

export type MatchInvoiceHandler = (
  transactionId: string,
  invoiceId: string
) => Promise<boolean>

// Category option type. `label` retains the Swedish text for back-compat and
// non-React consumers; `labelKey` is the next-intl key under the `tx_categories`
// namespace that React components should prefer.
export interface CategoryOption {
  value: TransactionCategory
  label: string
  labelKey: string
  account?: string
}

// Shared category arrays
export const EXPENSE_CATEGORIES: CategoryOption[] = [
  { value: 'expense_representation', label: 'Representation', labelKey: 'expense_representation', account: '6071' },
  { value: 'expense_equipment', label: 'Utrustning', labelKey: 'expense_equipment', account: '5410' },
  { value: 'expense_software', label: 'Programvara', labelKey: 'expense_software', account: '5420' },
  { value: 'expense_consumables', label: 'Material', labelKey: 'expense_consumables', account: '5460' },
  { value: 'expense_travel', label: 'Resor', labelKey: 'expense_travel', account: '5800' },
  { value: 'expense_office', label: 'Kontor', labelKey: 'expense_office', account: '6110' },
  { value: 'expense_vehicle', label: 'Bil & drivmedel', labelKey: 'expense_vehicle', account: '5611' },
  { value: 'expense_telecom', label: 'Telefon & internet', labelKey: 'expense_telecom', account: '6200' },
  { value: 'expense_marketing', label: 'Marknadsföring', labelKey: 'expense_marketing', account: '5910' },
  { value: 'expense_professional_services', label: 'Konsulter', labelKey: 'expense_professional_services', account: '6530' },
  { value: 'expense_education', label: 'Utbildning', labelKey: 'expense_education', account: '6991' },
  { value: 'expense_bank_fees', label: 'Bankavgift', labelKey: 'expense_bank_fees', account: '6570' },
  { value: 'expense_card_fees', label: 'Kortavgift', labelKey: 'expense_card_fees', account: '6570' },
  { value: 'expense_currency_exchange', label: 'Valutaväxling', labelKey: 'expense_currency_exchange', account: '7960' },
  { value: 'expense_other', label: 'Övrigt', labelKey: 'expense_other', account: '6991' },
]

export const INCOME_CATEGORIES: CategoryOption[] = [
  { value: 'income_services', label: 'Tjänster', labelKey: 'income_services', account: '3001' },
  { value: 'income_products', label: 'Produkter', labelKey: 'income_products', account: '3001' },
  { value: 'income_other', label: 'Övrigt', labelKey: 'income_other', account: '3900' },
]

export interface VatTreatmentOption {
  value: VatTreatment | 'none'
  label: string
  labelKey: string
  description?: string
  descriptionKey?: string
}

export const VAT_TREATMENT_OPTIONS: VatTreatmentOption[] = [
  { value: 'standard_25', label: 'Moms 25%', labelKey: 'vat_standard_25' },
  { value: 'reduced_12', label: 'Moms 12%', labelKey: 'vat_reduced_12', description: 'Livsmedel, hotell, camping', descriptionKey: 'vat_reduced_12_desc' },
  { value: 'reduced_6', label: 'Moms 6%', labelKey: 'vat_reduced_6', description: 'Böcker, tidningar, kollektivtrafik', descriptionKey: 'vat_reduced_6_desc' },
  { value: 'reverse_charge', label: 'Omvänd skattskyldighet', labelKey: 'vat_reverse_charge', description: 'Köparen redovisar momsen (EU-tjänster m.m.)', descriptionKey: 'vat_reverse_charge_desc' },
  { value: 'export', label: 'Export', labelKey: 'vat_export', description: 'Försäljning utanför EU (behåller avdragsrätt)', descriptionKey: 'vat_export_desc' },
  { value: 'exempt', label: 'Momsfri', labelKey: 'vat_exempt', description: 'Undantaget enligt ML (vård, utbildning, finans)', descriptionKey: 'vat_exempt_desc' },
  { value: 'none', label: 'Ingen moms', labelKey: 'vat_none', description: 'Ej momspliktigt (t.ex. lön, privata uttag)', descriptionKey: 'vat_none_desc' },
]
