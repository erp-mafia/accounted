// Shared vocabulary for pending_operations rendering: labels, warnings and
// rejection categories used by every surface that shows a staged operation
// (/pending, the chat approval card, future flow-run views). Moved here from
// app/(dashboard)/pending/page.tsx so the vocabulary has exactly one owner.

import type { PendingOperationRejectionCategory } from '@/types'

// Short human label (i18n key in the "pending" namespace) for each staged
// operation_type. Keep in sync with OPERATION_RISK_TIERS in
// lib/pending-operations/risk-tiers.ts: every operation an agent can stage
// needs a label here, otherwise the Granskning list falls back to the raw
// snake_case tool name (e.g. "create_supplier_invoice_from_inbox"), which is
// long and pushes the meta row to wrap awkwardly on mobile.
export const OPERATION_LABEL_KEYS: Record<string, string> = {
  categorize_transaction: 'type_categorize_transaction',
  create_customer: 'type_create_customer',
  create_invoice: 'type_create_invoice',
  create_transaction: 'type_create_transaction',
  create_voucher: 'type_create_voucher',
  correct_entry: 'type_correct_entry',
  reverse_entry: 'type_reverse_entry',
  mark_invoice_paid: 'type_mark_invoice_paid',
  send_invoice: 'type_send_invoice',
  mark_invoice_sent: 'type_mark_invoice_sent',
  match_transaction_invoice: 'type_match_transaction_invoice',
  // Master data
  create_supplier: 'type_create_supplier',
  create_article: 'type_create_article',
  update_article: 'type_update_article',
  create_account: 'type_create_account',
  update_account: 'type_update_account',
  create_dimension_value: 'type_create_dimension_value',
  // Supplier invoices
  create_supplier_invoice_from_inbox: 'type_create_supplier_invoice_from_inbox',
  create_self_billed_supplier_invoice: 'type_create_self_billed_supplier_invoice',
  approve_supplier_invoice: 'type_approve_supplier_invoice',
  credit_supplier_invoice: 'type_credit_supplier_invoice',
  // Invoices
  credit_invoice: 'type_credit_invoice',
  convert_invoice: 'type_convert_invoice',
  // Documents & links
  attach_document_to_transaction: 'type_attach_document_to_transaction',
  link_document_to_voucher: 'type_link_document_to_voucher',
  link_documents_to_vouchers: 'type_link_documents_to_vouchers',
  link_invoice_voucher: 'type_link_invoice_voucher',
  link_supplier_invoice_voucher: 'type_link_supplier_invoice_voucher',
  link_transaction_journal_entry: 'type_link_transaction_journal_entry',
  uncategorize_transaction: 'type_uncategorize_transaction',
  retag_line_dimensions: 'type_retag_line_dimensions',
  set_voucher_note: 'type_set_voucher_note',
  // Bulk booking / allocation
  match_batch_allocate: 'type_match_batch_allocate',
  bulk_book_transactions: 'type_bulk_book_transactions',
  bulk_book_inbox_items: 'type_bulk_book_inbox_items',
  // Periods, year-end, depreciation
  close_period: 'type_close_period',
  lock_period: 'type_lock_period',
  unlock_period: 'type_unlock_period',
  set_opening_balances: 'type_set_opening_balances',
  run_year_end: 'type_run_year_end',
  run_currency_revaluation: 'type_run_currency_revaluation',
  post_annual_depreciation: 'type_post_annual_depreciation',
  explain_voucher_gap: 'type_explain_voucher_gap',
  // SIE
  import_sie: 'type_import_sie',
  undo_sie_import: 'type_undo_sie_import',
  // Payroll & Skatteverket filings
  create_salary_run: 'type_create_salary_run',
  book_salary_run: 'type_book_salary_run',
  generate_agi: 'type_generate_agi',
  update_payslip_line: 'type_update_payslip_line',
  set_run_salary: 'type_set_run_salary',
  register_absence: 'type_register_absence',
  delete_absence: 'type_delete_absence',
  create_employee: 'type_create_employee',
  update_employee: 'type_update_employee',
  set_employee_opening_balances: 'type_set_employee_opening_balances',
  vacation_year_close: 'type_vacation_year_close',
  submit_vat_declaration: 'type_submit_vat_declaration',
  submit_agi: 'type_submit_agi',
}

// Fallback for an operation_type with no entry above (e.g. a newly added op
// not yet given a label): turn "create_supplier_invoice_from_inbox" into
// "Create supplier invoice from inbox" so it never surfaces as raw snake_case.
export function humanizeOperationType(operationType: string): string {
  const spaced = operationType.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function operationLabel(operationType: string, t: (key: string) => string): string {
  const labelKey = OPERATION_LABEL_KEYS[operationType]
  return labelKey ? t(labelKey) : humanizeOperationType(operationType)
}

// Full-sentence warning for the single-op confirmation dialog AND the inline
// list-view warning when risk is medium/high. The list-view truncates beyond
// one line; the dialog shows it in full. Order roughly low → high risk so
// reviewers scanning the source see the destructive paths grouped together.
export const singleActionWarnings: Record<string, string> = {
  // Low/medium risk: light verifikation work
  create_transaction: 'Genom att klicka godkänn så skapar du en transaktion.',
  create_customer: 'Genom att klicka godkänn så skapar du en kund.',
  create_invoice: 'Genom att klicka godkänn så skapas ett fakturautkast (det skickas inte).',
  categorize_transaction: 'Genom att klicka godkänn så kategoriseras transaktionen och en verifikation skapas.',
  match_transaction_invoice: 'Genom att klicka godkänn så matchas transaktionen mot fakturan.',
  attach_document_to_transaction: 'Genom att klicka godkänn så bifogas dokumentet till transaktionen.',
  uncategorize_transaction: 'Genom att klicka godkänn så tas kategoriseringen bort.',
  send_invoice: 'Genom att klicka godkänn så skickas fakturan till kunden.',
  mark_invoice_paid: 'Genom att klicka godkänn så bokförs en betalning på fakturan.',
  mark_invoice_sent: 'Genom att klicka godkänn så märks fakturan som skickad och en verifikation skapas.',
  // High risk: period/year-end/voucher edits. These are the ones the reviewer
  // really needs the warning for, so we keep them concrete: name the
  // irreversibility or compliance consequence, not the generic risk-level.
  lock_period: 'Genom att klicka godkänn så låses perioden: inga nya verifikationer kan bokföras tills den låses upp.',
  unlock_period: 'Genom att klicka godkänn så låses perioden upp. Använd endast för rättelser; lås igen efter.',
  close_period: 'Genom att klicka godkänn så stängs perioden permanent (BFL). Stängningen kan inte ångras.',
  run_year_end: 'Genom att klicka godkänn så körs bokslut: resultatkonton nollställs, perioden låses, nästa period skapas.',
  set_opening_balances: 'Genom att klicka godkänn så bokförs ingående balans i nästa period.',
  run_currency_revaluation: 'Genom att klicka godkänn så bokförs valutaomvärdering (3960/7960).',
  create_voucher: 'Genom att klicka godkänn så bokförs verifikationen med ett nytt löpnummer.',
  correct_entry: 'Genom att klicka godkänn så stornas originalverifikationen och en rättelse bokförs (BFL 5 kap 5§).',
  reverse_entry: 'Genom att klicka godkänn så stornas verifikationen: originalet behålls synligt (BFL 5 kap).',
  credit_invoice: 'Genom att klicka godkänn så skapas en kreditfaktura och originalverifikationen stornas.',
  credit_supplier_invoice: 'Genom att klicka godkänn så krediteras leverantörsfakturan och registreringsverifikationen stornas.',
  approve_supplier_invoice: 'Genom att klicka godkänn så attesteras leverantörsfakturan och blir betalningsbar.',
  convert_invoice: 'Genom att klicka godkänn så konverteras proformafakturan till en riktig faktura med F-nummer.',
  import_sie: 'Genom att klicka godkänn så importeras SIE-filen: räkenskapsperiod, ingående balans och verifikationer skapas.',
  explain_voucher_gap: 'Genom att klicka godkänn så dokumenteras förklaringen för verifikationsluckan (BFNAR 2013:2).',
  post_annual_depreciation: 'Genom att klicka godkänn så bokförs planenlig avskrivning: en verifikation per tillgång.',
}

export function singleActionWarning(operationType: string): string {
  return singleActionWarnings[operationType] ?? ''
}

// Structured rejection categories. One canonical list: /pending's reject
// dialog and the chat approval card's reject form render the same options
// and store the same values (surfaced back to the agent via
// gnubok_get_recent_rejections).
export const REJECTION_CATEGORY_LABELS: Record<PendingOperationRejectionCategory, string> = {
  wrong_category: 'Fel kategori / konto',
  wrong_amount: 'Fel belopp',
  duplicate: 'Dubblett',
  wrong_period: 'Fel period',
  other: 'Annat',
}
