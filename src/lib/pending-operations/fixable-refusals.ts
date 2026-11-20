/**
 * The refusals of an approval that the person approving in the app can fix
 * WITHOUT changing the proposal (tracker #206 point 2). The one list.
 *
 * For these, the app's single approval (the commit route, which sets
 * CommitOptions.keepFixableRefusals) hands the proposal back to 'pending'
 * instead of consuming it as rejected: the page says what to fix, and
 * Godkänn works again on the same proposal afterwards. Every other door
 * (bulk approval, API keys, agents) keeps the rejection: an agent restages,
 * and a kept proposal beside its restaged twin would be two proposals for
 * one booking.
 *
 * A code belongs here only when BOTH hold for each operation type named:
 *   1. the executor refuses with it before it has written anything, so the
 *      second approval starts from the same books as the first;
 *   2. what is wrong lies outside the proposal (a setting, a session, a
 *      confirmation), so the same proposal is right once it is fixed.
 * Anything else is not listed and keeps closing the proposal. Adding a code
 * means reading its executor from the top to the refusal for writes.
 *
 * Client-safe: plain constants, read by the dispatcher (commit.ts) and by
 * the approvals page for the link to the fix.
 */
import { IMPORT_HISTORY_HREF } from '@/lib/onboarding-books/skip'

export interface FixableRefusal {
  /** The operation types whose executor refuses with this code before any write; 'any' when the dispatcher itself answers it. */
  operationTypes: readonly string[] | 'any'
  /** The page where the person fixes it, when there is one. */
  fixHref?: string
}

export const FIXABLE_REFUSALS: Readonly<Record<string, FixableRefusal>> = {
  // create_voucher: the booking-time warnings (a duplicate in the books, an
  // implausible line) run again at approval, after reads only and before the
  // verifikat is posted. The person reads them and confirms; the approval is
  // sent again with acknowledged_warnings, the guard runs again, and the
  // booking leaves a behandlingshistorik record of what was confirmed.
  VOUCHER_NEEDS_CONFIRMATION: { operationTypes: ['create_voucher'] },
  // The Skatteverket filings and skattekonto bookings: the person's BankID
  // session with Skatteverket is missing or has run out (they last about ten
  // hours). Answered before anything is sent or booked, and already kept
  // pending for every door by the dispatcher (SkatteverketRecoverableError,
  // and its 401). Listed for the page's reconnect link.
  SKATTEVERKET_NOT_CONNECTED: { operationTypes: 'any', fixHref: '/settings/skatteverket' },
  // The three below are answered by the issue step both invoice doors share
  // (issuable and the numbering in lib/invoices/issue-and-book-invoice.ts):
  // before a number is drawn, before the status changes, before any
  // verifikat. The one write that can come before them is the draft's own
  // printed payee, refreshed from the bank account the invoice chose
  // (snapshotInvoicePayee): no booking, the same value every time, written
  // again by the next approval and by a restaged proposal alike.
  //
  // mark_invoice_sent only: the series already has a higher number
  // (generate_invoice_number refuses and draws nothing). The person sets
  // Nästa fakturanummer or a prefix. Not send_invoice (attachments are linked
  // and a delivery reserved before its numbering) and not convert_to_invoice
  // (the invoice is written, then restored).
  INVOICE_NUMBER_SERIES_BEHIND: { operationTypes: ['mark_invoice_sent'], fixHref: '/settings/invoicing' },
  // The company has no payment details for the invoice currency (bankgiro,
  // plusgiro, Swish, bank account or IBAN). The person adds them.
  INVOICE_SEND_PAYMENT_ACCOUNT_MISSING: { operationTypes: ['mark_invoice_sent', 'send_invoice'], fixHref: '/settings/invoicing' },
  // The company is VAT-registered without a VAT number, which the invoice
  // must carry (ML 17 kap. 24 §). The person adds it.
  INVOICE_SEND_VAT_NUMBER_MISSING: { operationTypes: ['mark_invoice_sent', 'send_invoice'], fixHref: '/settings/tax' },
  // import_sie: another SIE import of the company is queued, running or
  // stopped mid-way (start_sie_import_job and start_sie_append_job refuse,
  // lib/import/sie-jobs.ts). The job RPC rolled back, so nothing was queued
  // or booked. What submitSIEJob writes before it is found again by the
  // second approval: the file archive is content-addressed and
  // ensureFiscalPeriod returns the year it created. The other import lies
  // outside the proposal; once it is done the same proposal is right. The
  // link opens the import history, where Fortsätt and Ångra import are.
  SIE_IMPORT_UNFINISHED: { operationTypes: ['import_sie'], fixHref: IMPORT_HISTORY_HREF },
}

/** The fix for a refusal of this operation type, or null when the refusal is not one a person fixes around the proposal. */
export function fixableRefusalFor(operationType: string, code: string | null | undefined): FixableRefusal | null {
  if (!code || !Object.hasOwn(FIXABLE_REFUSALS, code)) return null
  const fix = FIXABLE_REFUSALS[code]
  return fix.operationTypes === 'any' || fix.operationTypes.includes(operationType) ? fix : null
}
