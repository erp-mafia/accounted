// Shared vocabulary for pending_operations rendering: labels, warnings and
// rejection categories used by every surface that shows a staged operation
// (/pending, the chat approval card, future flow-run views). Moved here from
// app/(dashboard)/pending/page.tsx so the vocabulary has exactly one owner.

import type { PendingOperationRejectionCategory, PendingOperationSystemRejectionCategory } from '@/types'
import { isHighRisk, PENDING_OPERATION_TYPES } from '@/lib/pending-operations/risk-tiers'
import {
  isRegisterBookedInvoiceParams,
  registerBookedLedgerOf,
  type RegisterBookedLedger,
} from '@/lib/invoices/register-booked-invoice-mode'
import { PAYMENT_FIELDS } from '@/lib/cash-accounts/invoice-payment-accounts'

// Short human label (i18n key in the "pending" namespace) for each staged
// operation_type: pending.type_<operation_type>, derived from the risk-tier
// table (lib/pending-operations/risk-tiers.ts), so every type an agent can
// stage has a key. operation-contract.test.ts checks both languages carry
// it; without one the Granskning list would show the raw snake_case name.
export const OPERATION_LABEL_KEYS: Readonly<Record<string, string>> = Object.fromEntries(
  PENDING_OPERATION_TYPES.map((type) => [type, `type_${type}`]),
)

// Fallback for an operation_type with no entry above (e.g. a newly added op
// not yet given a label): turn "create_supplier_invoice_from_inbox" into
// "Create supplier invoice from inbox" so it never surfaces as raw snake_case.
export function humanizeOperationType(operationType: string): string {
  const spaced = operationType.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** The label key of a registration of an already-booked invoice, per reskontra (crm#1094). */
const REGISTER_BOOKED_LABEL_KEYS: Record<RegisterBookedLedger, string> = {
  customer: 'type_register_booked_invoice',
  supplier: 'type_register_booked_supplier_invoice',
}

/**
 * The label of a staged operation. A create_invoice staged by
 * gnubok_register_booked_invoice, or a create_supplier_invoice_from_inbox
 * staged by gnubok_register_booked_supplier_invoice, registers an invoice that
 * is already booked instead of creating one (crm#1094), so with its params it
 * gets its own label rather than "Ny faktura" or "Leverantörsfaktura".
 */
export function operationLabel(
  operationType: string,
  t: (key: string) => string,
  params?: Record<string, unknown> | null,
): string {
  const ledger = registerBookedLedgerOf(operationType, params)
  if (ledger) return t(REGISTER_BOOKED_LABEL_KEYS[ledger])
  const labelKey = OPERATION_LABEL_KEYS[operationType]
  return labelKey ? t(labelKey) : humanizeOperationType(operationType)
}

// The consequence sentence of each staged operation type that has one, the
// sentence the approver consents to: a message key in the "pending"
// namespace, so it follows the user's language. It shows in full in the
// single-op confirmation dialog and, when risk is medium/high, as the inline
// list-view warning (truncated beyond one line). Resolved by
// singleActionWarning.
export const SINGLE_ACTION_WARNING_KEYS: Readonly<Record<string, string>> = {
  book_counterparty_setoff: 'warning_book_counterparty_setoff',
  book_inventory_count: 'warning_book_inventory_count',
  merge_customers: 'warning_merge_customers',
  request_signature: 'warning_request_signature',
  request_arsredovisning_signatures: 'warning_request_arsredovisning_signatures',
  reminder_daily_batch: 'warning_reminder_daily_batch',
  delete_asset: 'warning_delete_asset',
  post_asset_value_adjustment: 'warning_post_asset_value_adjustment',
  replace_asset_component: 'warning_replace_asset_component',
  set_asset_transition_split: 'warning_set_asset_transition_split',
  update_accounting_policies: 'warning_update_accounting_policies',
  commit_k3_transition: 'warning_commit_k3_transition',
  delete_fiscal_period: 'warning_delete_fiscal_period',
  register_share_event: 'warning_register_share_event',
  update_share_class: 'warning_update_share_class',
  confirm_beneficial_owners: 'warning_confirm_beneficial_owners',
  create_dividend: 'warning_create_dividend',
  book_dividend: 'warning_book_dividend',
  pay_dividend: 'warning_pay_dividend',
  create_shareholder_contribution: 'warning_create_shareholder_contribution',
  create_capital_change: 'warning_create_capital_change',
  book_capital_change: 'warning_book_capital_change',
  set_k10_owner_inputs: 'warning_set_k10_owner_inputs',
  create_owner_loan: 'warning_create_owner_loan',
  update_owner_loan: 'warning_update_owner_loan',
  set_owner_loan_interest: 'warning_set_owner_loan_interest',
  hold_corporate_meeting: 'warning_hold_corporate_meeting',
  save_tax_loss_carryforward: 'warning_save_tax_loss_carryforward',
  book_webshop_day: 'warning_book_webshop_day',
  create_accrual_schedule: 'warning_create_accrual_schedule',
  cancel_accrual_schedule: 'warning_cancel_accrual_schedule',
  // The sentence for a change of the payment details; singleActionWarning
  // drops their clause when the change has none (crm#1605).
  update_company_settings: 'warning_update_company_settings_payment',
  // High-tier types that had no sentence, so their approval showed none (accounted#22).
  settle_rot_rut_payout: 'warning_settle_rot_rut_payout',
  post_kontantmetod_cutoff: 'warning_post_kontantmetod_cutoff',
  bulk_book_inbox_items: 'warning_bulk_book_inbox_items',
  book_salary_run: 'warning_book_salary_run',
  generate_agi: 'warning_generate_agi',
  vacation_year_close: 'warning_vacation_year_close',
  submit_vat_declaration: 'warning_submit_vat_declaration',
  submit_agi: 'warning_submit_agi',
  // From here roughly low → high risk, so reviewers scanning the source see
  // the destructive paths grouped together.
  // Low/medium risk: light verifikation work
  create_transaction: 'warning_create_transaction',
  create_customer: 'warning_create_customer',
  update_supplier: 'warning_update_supplier',
  archive_supplier: 'warning_archive_supplier',
  update_cash_account: 'warning_update_cash_account',
  set_primary_cash_account: 'warning_set_primary_cash_account',
  set_invoice_payee_default: 'warning_set_invoice_payee_default',
  change_bank_ledgers: 'warning_change_bank_ledgers',
  create_fiscal_period: 'warning_create_fiscal_period',
  update_fiscal_period: 'warning_update_fiscal_period',
  close_fiscal_period_external: 'warning_close_fiscal_period_external',
  reopen_fiscal_period_external: 'warning_reopen_fiscal_period_external',
  delete_account: 'warning_delete_account',
  update_company_tax_profile: 'warning_update_company_tax_profile',
  update_bookkeeping_lock: 'warning_update_bookkeeping_lock',
  enable_package: 'warning_enable_package',
  disable_package: 'warning_disable_package',
  create_grant: 'warning_create_grant',
  revoke_grant: 'warning_revoke_grant',
  revoke_service_account: 'warning_revoke_service_account',
  send_payslips: 'warning_send_payslips',
  unapprove_salary_run: 'warning_unapprove_salary_run',
  attach_salary_expense_claims: 'warning_attach_salary_expense_claims',
  add_salary_run_employee: 'warning_add_salary_run_employee',
  remove_salary_run_employee: 'warning_remove_salary_run_employee',
  add_payslip_line: 'warning_add_payslip_line',
  delete_payslip_line: 'warning_delete_payslip_line',
  mark_salary_run_paid: 'warning_mark_salary_run_paid',
  correct_salary_run: 'warning_correct_salary_run',
  set_worked_days: 'warning_set_worked_days',
  delete_worked_days: 'warning_delete_worked_days',
  add_employee_benefit: 'warning_add_employee_benefit',
  update_employee_benefit: 'warning_update_employee_benefit',
  delete_employee_benefit: 'warning_delete_employee_benefit',
  add_employee_recurring_line: 'warning_add_employee_recurring_line',
  update_employee_recurring_line: 'warning_update_employee_recurring_line',
  delete_employee_recurring_line: 'warning_delete_employee_recurring_line',
  delete_employee: 'warning_delete_employee',
  create_supplier_payment_batch: 'warning_create_supplier_payment_batch',
  cancel_supplier_payment_batch: 'warning_cancel_supplier_payment_batch',
  prepare_payment_orders: 'warning_prepare_payment_orders',
  cancel_payment_order: 'warning_cancel_payment_order',
  confirm_supplier_payee: 'warning_confirm_supplier_payee',
  bank_feed_invite: 'warning_bank_feed_invite',
  request_payment_signature: 'warning_request_payment_signature',
  book_invoice: 'warning_book_invoice',
  bulk_book_invoices: 'warning_bulk_book_invoices',
  book_supplier_invoice: 'warning_book_supplier_invoice',
  create_expense_claim: 'warning_create_expense_claim',
  delete_expense_claim: 'warning_delete_expense_claim',
  record_expense_payout: 'warning_record_expense_payout',
  match_expense_payout: 'warning_match_expense_payout',
  link_transaction_journal_entry: 'warning_link_transaction_journal_entry',
  match_batch_allocate: 'warning_match_batch_allocate',
  bulk_book_transactions: 'warning_bulk_book_transactions',
  delete_document: 'warning_delete_document',
  set_document_type: 'warning_set_document_type',
  // The sentence for a removal that keeps nothing to put back; singleActionWarning
  // promises Senast borttagna only when the staged preview says the item can come back.
  delete_inbox_item: 'warning_delete_inbox_item',
  undo_bank_import: 'warning_undo_bank_import',
  correct_entry_metadata: 'warning_correct_entry_metadata',
  correct_entry_lines_inline: 'warning_correct_entry_lines_inline',
  redate_entry: 'warning_redate_entry',
  mark_no_document_required: 'warning_mark_no_document_required',
  book_vat_settlement: 'warning_book_vat_settlement',
  mark_not_momsredovisning: 'warning_mark_not_momsredovisning',
  withdraw_not_momsredovisning: 'warning_withdraw_not_momsredovisning',
  send_invoice_peppol: 'warning_send_invoice_peppol',
  register_peppol_participant: 'warning_register_peppol_participant',
  request_peppol_access: 'warning_request_peppol_access',
  update_arsredovisning_narrative: 'warning_update_arsredovisning_narrative',
  update_arsredovisning_compliance: 'warning_update_arsredovisning_compliance',
  create_arsredovisning_version: 'warning_create_arsredovisning_version',
  add_arsredovisning_signature: 'warning_add_arsredovisning_signature',
  set_opening_balances_manual: 'warning_set_opening_balances_manual',
  correct_opening_balances: 'warning_correct_opening_balances',
  disconnect_pos_connection: 'warning_disconnect_pos_connection',
  update_pos_sales_settings: 'warning_update_pos_sales_settings',
  book_webshop_order: 'warning_book_webshop_order',
  book_pos_sales_day: 'warning_book_pos_sales_day',
  book_spend_item: 'warning_book_spend_item',
  book_spend_items: 'warning_book_spend_items',
  update_spend_settings: 'warning_update_spend_settings',
  disconnect_spend_connection: 'warning_disconnect_spend_connection',
  split_opening_balances_per_project: 'warning_split_opening_balances_per_project',
  open_collection_case: 'warning_open_collection_case',
  collection_case_action: 'warning_collection_case_action',
  book_collected_payment: 'warning_book_collected_payment',
  book_collection_settlement: 'warning_book_collection_settlement',
  collections_daily_batch: 'warning_collections_daily_batch',
  record_customer_loss: 'warning_record_customer_loss',
  delete_supplier_invoice: 'warning_delete_supplier_invoice',
  uncredit_supplier_invoice: 'warning_uncredit_supplier_invoice',
  update_supplier_invoice: 'warning_update_supplier_invoice',
  update_supplier_invoice_item_account: 'warning_update_supplier_invoice_item_account',
  delete_dimension: 'warning_delete_dimension',
  create_invoice: 'warning_create_invoice',
  categorize_transaction: 'warning_categorize_transaction',
  match_transaction_invoice: 'warning_match_transaction_invoice',
  attach_document_to_transaction: 'warning_attach_document_to_transaction',
  uncategorize_transaction: 'warning_uncategorize_transaction',
  send_invoice: 'warning_send_invoice',
  mark_invoice_paid: 'warning_mark_invoice_paid',
  mark_invoice_sent: 'warning_mark_invoice_sent',
  // High risk: period/year-end/voucher edits. These are the ones the reviewer
  // really needs the warning for, so we keep them concrete: name the
  // irreversibility or compliance consequence, not the generic risk-level.
  lock_period: 'warning_lock_period',
  unlock_period: 'warning_unlock_period',
  undo_sie_import: 'warning_undo_sie_import',
  acknowledge_opening_balance_review: 'warning_acknowledge_opening_balance_review',
  close_period: 'warning_close_period',
  run_year_end: 'warning_run_year_end',
  set_opening_balances: 'warning_set_opening_balances',
  run_currency_revaluation: 'warning_run_currency_revaluation',
  create_voucher: 'warning_create_voucher',
  correct_entry: 'warning_correct_entry',
  reverse_entry: 'warning_reverse_entry',
  credit_invoice: 'warning_credit_invoice',
  link_credit_note_to_invoice: 'warning_link_credit_note_to_invoice',
  delete_draft_invoice: 'warning_delete_draft_invoice',
  credit_supplier_invoice: 'warning_credit_supplier_invoice',
  approve_supplier_invoice: 'warning_approve_supplier_invoice',
  convert_invoice: 'warning_convert_invoice',
  import_sie: 'warning_import_sie',
  explain_voucher_gap: 'warning_explain_voucher_gap',
  post_annual_depreciation: 'warning_post_annual_depreciation',
  create_asset: 'warning_create_asset',
  update_asset: 'warning_update_asset',
  dispose_asset: 'warning_dispose_asset',
}

/** The schedule types whose tier rises to 'high' with auto_send (risk-tiers.ts). */
const RECURRING_SCHEDULE_TYPES: ReadonlySet<string> = new Set(['create_recurring_schedule', 'update_recurring_schedule'])

/** What approving a registration of an already-booked invoice does, per reskontra (crm#1094). */
const REGISTER_BOOKED_SENTENCE_KEYS: Record<RegisterBookedLedger, string> = {
  customer: 'warning_register_booked_invoice',
  supplier: 'warning_register_booked_supplier_invoice',
}

/**
 * What approving a send delivers, by the preview's document_kind (the server's
 * sentDocumentKind): a quote, a proforma or a credit note is not "the
 * invoice". An invoice, and a row staged before the preview carried the kind,
 * keep the send_invoice sentence.
 */
const SEND_DOCUMENT_SENTENCE_KEYS: Readonly<Record<string, string>> = {
  quote: 'warning_send_invoice_quote',
  proforma: 'warning_send_invoice_proforma',
  credit_note: 'warning_send_invoice_credit_note',
}

/**
 * The consequence sentence the approver consents to. Keyed on the operation
 * type; the types whose outcome depends on their params read them, so the
 * dialog never promises what the approval will not do: convert_invoice with
 * target 'order' creates a draft kundorder (no F-number, nothing booked), and
 * a create_invoice or create_supplier_invoice_from_inbox staged as the
 * registration of an already-booked invoice posts nothing (crm#1094).
 * Two types read the staged preview instead: delete_inbox_item says the item
 * can be put back only when the preview's can_be_put_back is true (the
 * server's removalCanBePutBack, lib/documents/inbox-item-state.ts), and
 * says permanent for every other removal, also one staged before the
 * preview carried it; send_invoice names the document it delivers
 * (SEND_DOCUMENT_SENTENCE_KEYS).
 * `t` reads the "pending" namespace.
 */
export function singleActionWarning(
  operationType: string,
  params: Record<string, unknown> | null | undefined,
  t: (key: string) => string,
  preview?: unknown,
): string {
  if (operationType === 'delete_inbox_item' && (preview as { can_be_put_back?: unknown } | null | undefined)?.can_be_put_back === true) {
    return t('warning_delete_inbox_item_put_back')
  }
  if (operationType === 'send_invoice') {
    const kind = (preview as { document_kind?: unknown } | null | undefined)?.document_kind
    if (typeof kind === 'string' && Object.hasOwn(SEND_DOCUMENT_SENTENCE_KEYS, kind)) {
      return t(SEND_DOCUMENT_SENTENCE_KEYS[kind])
    }
  }
  if (operationType === 'convert_invoice' && params?.target === 'order') {
    return t('warning_convert_invoice_order')
  }
  if (operationType === 'convert_invoice' && (params?.percent !== undefined || params?.amount !== undefined)) {
    return t('warning_convert_invoice_partial')
  }
  const ledger = registerBookedLedgerOf(operationType, params)
  if (ledger) return t(REGISTER_BOOKED_SENTENCE_KEYS[ledger])
  // Payslips to a Kivra or Billo mailbox: the email link only for whoever it does not reach.
  if (operationType === 'send_payslips' && (params?.channel === 'kivra' || params?.channel === 'billo')) {
    return t('warning_send_payslips_mailbox')
  }
  // A kontantfaktura (crm#1281): issued already paid, not merely sent.
  if (operationType === 'mark_invoice_sent' && params?.paid_at_issue) {
    return t('warning_mark_invoice_sent_paid_at_issue')
  }
  // A rule for a supplier's invoices from the inbox (grants slice 2), not a bank line's.
  if (operationType === 'create_grant' && params?.operation_type === 'create_supplier_invoice_from_inbox') {
    return t('warning_create_grant_supplier_invoice')
  }
  // A schedule that emails every run is high risk only by its params; the
  // sentence follows the tier, so it shows exactly when the row is 'high'.
  if (RECURRING_SCHEDULE_TYPES.has(operationType) && isHighRisk(operationType, params ?? undefined)) {
    return t('warning_recurring_schedule_auto_send')
  }
  // Payment details steer where customers pay, so the sentence says so only
  // when the settings change touches them (crm#1605).
  if (operationType === 'update_company_settings' && params && !changesInvoicePayee(params)) {
    return t('warning_update_company_settings')
  }
  const key = SINGLE_ACTION_WARNING_KEYS[operationType]
  return key ? t(key) : ''
}

/**
 * Whether a staged settings change moves where customers pay: a field of the
 * invoice payment account (the company's SEK payee columns) or the
 * per-currency map, both written through to the payee cash account
 * (propagateLegacyPayeeWrite). A row staged before settings.update keeps its
 * fields under `changes` (upgradeLegacyCompanySettingsParams).
 */
function changesInvoicePayee(params: Record<string, unknown>): boolean {
  const legacy = params.changes
  const fields =
    legacy != null && typeof legacy === 'object' && !Array.isArray(legacy) ? { ...params, ...legacy } : params
  return 'invoice_payment_accounts' in fields || PAYMENT_FIELDS.some((field) => field in fields)
}

/**
 * The consent sentence a pending Granskning row shows before any click. High
 * risk shows it (its approval opens a dialog with it as well). So does a
 * registration of an already-booked invoice (crm#1094): it cannot be undone,
 * but it keeps its pending type's 'medium' tier so a whole reskontra can be
 * approved at once (risk-tiers.ts), and such an approval opens no dialog.
 */
export function rowConsentSentence(
  op: {
    operation_type: string
    status: string
    risk_level?: string | null
    params?: Record<string, unknown> | null
    preview_data?: unknown
  },
  t: (key: string) => string,
): string {
  if (op.status !== 'pending') return ''
  const registration = registerBookedLedgerOf(op.operation_type, op.params) !== null
  return op.risk_level === 'high' || registration
    ? singleActionWarning(op.operation_type, op.params, t, op.preview_data)
    : ''
}

/**
 * The bulk confirmation's line for registrations of already-booked invoices
 * (crm#1094): with the row's sentence, what tells a bulk approver that the
 * registrations cannot be undone.
 */
export function registerBookedInvoiceBulkLine(count: number): string {
  return count === 1
    ? 'En redan bokförd faktura registreras i kundreskontran (inget bokförs, kan inte ångras).'
    : `${count} redan bokförda fakturor registreras i kundreskontran (inget bokförs, kan inte ångras).`
}

/** registerBookedInvoiceBulkLine for the leverantörsreskontra. */
export function registerBookedSupplierInvoiceBulkLine(count: number): string {
  return count === 1
    ? 'En redan bokförd leverantörsfaktura registreras i leverantörsreskontran (inget bokförs, kan inte ångras).'
    : `${count} redan bokförda leverantörsfakturor registreras i leverantörsreskontran (inget bokförs, kan inte ångras).`
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

// Rejections nobody made: shown on a resolved operation, never offered in a picker.
const SYSTEM_REJECTION_LABELS: Record<PendingOperationSystemRejectionCategory, string> = {
  expired: 'Utgick automatiskt',
  superseded: 'Ersatt',
  failed: 'Misslyckades vid godkännandet',
}

export function rejectionCategoryLabel(
  category: PendingOperationRejectionCategory | PendingOperationSystemRejectionCategory,
): string {
  return category in REJECTION_CATEGORY_LABELS
    ? REJECTION_CATEGORY_LABELS[category as PendingOperationRejectionCategory]
    : SYSTEM_REJECTION_LABELS[category as PendingOperationSystemRejectionCategory]
}

/**
 * The advisory warning a staging tool attached to an operation, read once for
 * every surface that shows it: the Granskning row, the bulk confirmation and
 * the preview. It used to be read per preview component, so a type whose
 * preview forgot the field (attach_document_to_transaction) never showed it,
 * and the row never did: "Godkänn alla" approved warned operations unseen
 * (crm#1003).
 *
 * - missing_underlag: create_voucher's note is agent guidance in English
 *   (it names tools), so the UI says it in its own words. Gated on the staged
 *   note, not on document_attached: the server decides when the warning
 *   applies (IB entries are exempt there), so the UI mirrors it instead of
 *   running a second, looser policy. The UI sentence stays conditional
 *   ("om ... avser en mottagen handling"): accruals and FX entries
 *   legitimately lack a kvitto.
 * - vat: create_invoice and update_invoice stage the VAT-treatment
 *   explanation twice, English prose in compliance_warning for the agent and
 *   Swedish in vat_warnings; only the Swedish one is for the approver.
 * - note: every other compliance_warning, rendered as the server wrote it.
 */
export type ComplianceWarning =
  | { kind: 'missing_underlag' }
  | { kind: 'vat'; text: string }
  | { kind: 'note'; text: string }

const VAT_WARNING_OPERATION_TYPES = new Set(['create_invoice', 'update_invoice'])

export function complianceWarningOf(op: {
  operation_type: string
  preview_data?: Record<string, unknown> | null
}): ComplianceWarning | null {
  const data = op.preview_data ?? {}
  // A registration of an already-booked invoice (crm#1094) carries no VAT
  // explanation: its warnings are Swedish notes about the verifikat and the
  // reminders, read like any other compliance_warning.
  if (VAT_WARNING_OPERATION_TYPES.has(op.operation_type) && !isRegisterBookedInvoiceParams(data)) {
    const texts = Array.isArray(data.vat_warnings)
      ? data.vat_warnings.flatMap((warning: unknown) => {
          const text =
            warning != null && typeof warning === 'object'
              ? (warning as { message_sv?: unknown }).message_sv
              : null
          return typeof text === 'string' && text.trim() ? [text.trim()] : []
        })
      : []
    return texts.length > 0 ? { kind: 'vat', text: texts.join(' ') } : null
  }
  const note = typeof data.compliance_warning === 'string' ? data.compliance_warning.trim() : ''
  if (!note) return null
  if (op.operation_type === 'create_voucher') return { kind: 'missing_underlag' }
  return { kind: 'note', text: note }
}
