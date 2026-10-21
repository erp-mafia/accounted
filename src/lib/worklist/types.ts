/**
 * Worklist: the unified "Att göra" pending-work model.
 *
 * One source of truth for what the user still has to do, shared by the
 * dashboard "Att göra" section, the sidebar badges, and (eventually) the
 * MCP list tools. Every surface that shows a pending-work count MUST read
 * it from lib/worklist so the numbers can never diverge: divergent counts
 * are exactly the "vampire transactions" problem this module exists to fix.
 *
 * Each category documents its "done" condition: the status field or link
 * whose write makes an item drop out of the count, everywhere, at once.
 */

export const WORKLIST_CATEGORIES = [
  /**
   * Unbooked bank transactions ("N st att bokföra").
   * Pending:  is_business IS NULL AND is_ignored = false.
   * Done:     any booking flow (categorize, match-invoice, bulk-book RPC,
   *           manual booking) sets is_business = true: including the
   *           multi-tx flows, whose RPCs set is_business on every linked tx:
   *           or the user ignores the transaction (is_ignored = true).
   * This is the canonical "unbooked" predicate. Do NOT count bare
   * journal_entry_id IS NULL: multi-allocation and bulk-booked transactions
   * keep journal_entry_id NULL (see lib/transactions/is-booked.ts).
   */
  'book_transaction',
  /**
   * Unbooked skattekonto rows ("N st skattekontohändelser att bokföra").
   * Pending:  skattekonto_transactions with status = 'booked' (Skatteverket's
   *           "tidigare": the event has happened on the tax account),
   *           journal_entry_id IS NULL and is_ignored = false. Rows with
   *           status = 'upcoming' are future charges with nothing to book
   *           yet and never reach the Transaktioner inbox, so they are not
   *           pending work either.
   * Done:     the skattekonto booking flows set journal_entry_id (here it IS
   *           the booked marker, unlike bank transactions), or the user
   *           ignores the row (is_ignored = true). Same predicate as the
   *           Transaktioner inbox's Skatteverket rows.
   */
  'book_skattekonto',
  /**
   * Unconsumed documents in the inbox ("N st underlag att hantera").
   * Pending:  invoice_inbox_items with a document and no
   *           created_supplier_invoice_id / created_journal_entry_id /
   *           matched_transaction_id, whose document is still unlinked.
   * Done:     any of those three columns gets stamped (match, book-direct,
   *           supplier-invoice conversion) or the document is linked to a
   *           journal entry. Mirrors /api/documents/inbox-available.
   */
  'inbox_document',
  /**
   * Suggested transaction↔invoice matches awaiting one-click confirm.
   * Pending:  unbooked transactions (see book_transaction) carrying a
   *           potential_invoice_id or potential_supplier_invoice_id hint, or
   *           settling several open invoices of one counterparty to the öre
   *           (recomputed at read time, no hint column; the row carries
   *           `allocations`).
   * Done:     the match is confirmed (booking clears is_business) or the
   *           hint column is cleared (for a set: an invoice of it is settled
   *           elsewhere, so the set no longer adds up). NOTE: a subset of
   *           book_transaction: excluded from `total` to avoid double-counting.
   */
  'suggested_match',
  /**
   * Supplier invoices awaiting approval ("attestera").
   * Pending:  supplier_invoices.status = 'registered' and not a credit note
   *           (a credit note is a reversal, never a payable), in a company
   *           that attests at all: never under kontantmetoden, which has no
   *           attest step (companyAttestsSupplierInvoices).
   * Done:     status moves to approved/paid/credited/….
   */
  'supplier_invoice_approval',
  /**
   * Posted verifikat without underlag (BFL 5 kap 7§ documentation gap).
   * Pending:  posted journal_entries of document-requiring source types with
   *           no current-version document_attachments row and no
   *           journal_entry_no_doc_required exemption.
   * Done:     a document is linked or an exemption is recorded.
   */
  'verifikat_missing_document',
  /**
   * Overdue customer invoices ("N kundfakturor har förfallit"), ONE item per
   * company: the count is the invoices, the total adds 1 (see
   * OverdueInvoicesDue and getWorklistCounts).
   * Pending:  a real invoice (not a credit note) still owed (sent, overdue,
   *           partially_paid) with remaining_amount > 0 and due_date before
   *           today in Stockholm: lib/invoices/overdue.ts, the same rows as
   *           the Förfallna view. Derived, never the stored status. An
   *           invoice the "Hos inkasso" view lists (an open collection case
   *           past delivery, or a case a person must look at) is left out:
   *           it has its own rows (collection_decision, collection_attention).
   * Done:     paid in full, credited or cancelled, handed to collections,
   *           or the due date moved.
   */
  'overdue_invoice',
  /**
   * Tax/VAT deadlines needing attention.
   * Pending:  deadlines.is_completed = false AND status IN
   *           ('action_needed', 'overdue'): same predicate as
   *           lib/deadlines/status-engine.ts getDeadlinesNeedingAttention().
   * Done:     submitted/confirmed (is_completed or status transition).
   */
  'deadline_action',
  /**
   * Agent-staged operations awaiting review ("Granskning").
   * Pending:  pending_operations.status = 'pending', staged by anyone but the
   *           system (a suggestion has its own row, below).
   * Done:     committed or rejected.
   */
  'pending_operations',
  /**
   * Suggestions: package switches the system proposed (lib/suggestions),
   * one Förslag card each with Ja, Inte nu and Visa aldrig, at most three
   * at a time, ranked (lib/suggestions/list.ts listOpenSuggestions; the
   * agent briefing shows the same three).
   * Pending:  a company_suggestions row in state 'open' whose
   *           pending_operations row (actor 'system') is still 'pending'.
   * Done:     approved (accepted), "Inte nu" or any other rejection (snoozed
   *           30 days), "Visa aldrig" (declined for good), or expired.
   * Counts what is shown: a fourth open suggestion waits for a free place.
   */
  'suggestion',
  /**
   * Accounts not signed off through the end of the previous month
   * ("N konton att stämma av"), only for companies that have adopted the
   * sign-off ritual (at least one account_reconciliations row ever).
   * Pending:  an enabled cash account (deduplicated per IBAN + currency) or a
   *           configured skattekonto whose latest ACTIVE sign-off has
   *           through_date before the last day of the previous month.
   * Done:     a sign-off through that date or later (POST .../signoff), or
   *           the account stops being reconcilable (disabled cash account).
   * Zero for companies with no sign-off at all: the nudge is for those who
   * reconcile monthly, not a new chore for everyone.
   */
  'reconciliation_due',
  /**
   * People the company owes for out-of-pocket purchases ("Betala ut utlägg
   * till Anna"), one item per person.
   * Pending:  expense_claims.status = 'registered' (booked as cost against a
   *           person-liability account 2893/2820/2018, nothing paid out yet),
   *           grouped by employee_id, or by claimant_name for the owner.
   * Done:     every claim of that person is marked 'paid' (a payout batch
   *           posted the 1930 leg), or the claim is deleted (storno).
   * Counts PEOPLE, not receipts: the action is one transfer per person.
   */
  'expense_payout',
  /**
   * The next skattekonto charge the balance does not cover ("Betala in till
   * Skatteverket"), one item at most.
   * Pending:  skattekonto_transactions with status = 'upcoming' (Skatteverket's
   *           "kommande": a charge it will draw on forfallodatum), grouped on
   *           the earliest due date on or after today, whose sum exceeds the
   *           last synced saldo (extension_data skattekonto_balance_snapshot).
   *           Ignored rows take part: Skatteverket draws regardless of our
   *           flag. With no snapshot the whole charge is the amount to pay in.
   * Done:     the saldo covers the charge (the payment reached Skatteverket
   *           and the next sync or file import shows it), or the due date
   *           passes and the charge becomes a booked event, which is then
   *           book_skattekonto's work, not this row's.
   * Never counts with book_skattekonto: that one is a verifikat to write for
   * a settled event; this one is money that has to move before a date.
   */
  'skattekonto_payment_due',
  /**
   * Arkiv (phase 2): documents held at the door because nothing ties them to
   * the company. Pending: document_attachments.admission_state = 'held'.
   * Done: a person admitted or removed the document.
   */
  'document_relevance',
  /**
   * Arkiv (phase 2): admitted documents the classifier could not type
   * (doc_type 'other' from the model) or typed with low confidence.
   * Done: a person picked the type.
   */
  'document_unclassified',
  /**
   * Arkiv (phase 3): admitted documents whose extraction has fields the two
   * readings disagreed on or a check rejected. Pending: current
   * document_extractions row with review_fields non-empty. Done: a person
   * settled every field.
   */
  'document_field_review',
  /**
   * Arkiv (phase 4): a payment an agreement says was due, with nothing on
   * the bank account within two weeks after the date. Pending:
   * agreement_obligations.status = 'missed'. Done: a matching transaction
   * arrives (the daily observation marks it matched) or the row is waived.
   */
  'agreement_payment_missed',
  /**
   * Arkiv (phase 6): a finding of the nightly lint that a person should look
   * at: a setting that contradicts a Skatteverket decision, an agreement
   * ending with an unknown notice period, a duplicate document, a document
   * that could not be read. Pending: arkiv_findings.status = 'open'. Done:
   * the person applies or dismisses it, or the next lint no longer sees it.
   */
  'arkiv_finding',
  /**
   * Issued invoices the Peppol network did not take ("Peppol-leveranser som
   * misslyckades"), one item per invoice.
   * Pending:  the invoice's newest peppol_deliveries row has status 'failed'
   *           or 'no_route' and the invoice is sent or overdue: the SQL
   *           function peppol_failed_invoice_ids, read on the session client
   *           (lib/invoices/peppol-failed-invoices.ts) and shared with the
   *           invoice list's "Peppol misslyckades" chip. Capped at 200.
   * Done:     a newer delivery that did not fail (a resend of changed
   *           content stages a new delivery row), or the invoice leaves sent
   *           and overdue (paid, partly paid, credited, cancelled).
   */
  'peppol_delivery_failed',
  /**
   * Invoices handed over to the collections provider whose case waits for
   * the company's decision ("N inkassoärenden väntar på ditt beslut"): the
   * next step to approve, a dispute, the customer's "already paid", legal
   * action.
   * Pending:  collection_cases open with stage 'awaiting_decision'.
   * Done:     the stage leaves 'awaiting_decision' (the company decided, or
   *           the provider moved on), read by the sync or the invoice page.
   */
  'collection_decision',
  /**
   * Collections cases a person must look at ("N saker kring inkasso behöver
   * åtgärdas"): the SQL function collection_attention_case_ids. In this
   * version: a handover the provider refused (until a new handover of the
   * invoice, or the invoice is paid or credited), an open case whose last
   * read or retry failed (until the next good read), a payment or credit
   * note report the drain gave up on (until a person retries it or marks it
   * handled), and a reported amount above what the provider still claims
   * (until a person marks it handled), a bank row the payment-candidate
   * sweep found for an open case (until it is booked or a person says it
   * pays something else, and a case the sweep paused until it is resumed or
   * closes), and a provider principal that differs from what the books
   * expect (until the daily reconcile finds them equal, and a case it paused
   * until it is resumed or closes). Settlements join it with their tables.
   * Done:     each source row leaves its state.
   */
  'collection_attention',
  /**
   * The day's collections batch waiting for an administrator ("N förfallna
   * fakturor att skicka vidare via {provider}"): the items of the one pending
   * collections_daily_batch operation the ladder cron staged. Counted here,
   * not under pending_operations.
   * Pending:  a collections_daily_batch operation with status 'pending'.
   * Done:     an administrator approved or rejected it, or the cron rejected
   *           it after 72 hours.
   */
  'collection_batch_ready',
  /**
   * Bank connections to switch from Enable Banking to Open Payments before
   * the campaign deadline ("Byt bankkopplingen för {bank} senast {date}"),
   * one item per connection.
   * Pending:  the campaign is on (OPENPAYMENTS_SWITCH_DEADLINE) and applies
   *           to the company (lib/bank-feed/door.ts), and an active Enable
   *           Banking row at a bank Open Payments reaches has no Open Payments
   *           sibling yet (lib/bank-feed/switch-campaign.ts switchStateFor).
   * Done:     the switch supersedes the row (status revoked, superseded_by
   *           set), an Open Payments connection at the same bank goes live,
   *           the row is removed, or the campaign is switched off.
   * Banks Open Payments does not reach are never counted here: their path is
   * file import, said by the bank_switch_uncovered notice.
   */
  'bank_switch',
  /**
   * The company's verification (know your customer) at the payment provider
   * is about to run out or has ("Förnya verifieringen för betalningar"), or
   * was never started by a company that pays its suppliers through Accounted
   * ("Verifiera företaget för betalningar via banken"), one item at most.
   * Bank payments are refused without it.
   * Pending:  payments through the bank are open to the company
   *           (lib/payments/orders/switched-on.ts) and the stored record
   *           (company_payment_verifications, refreshed by the payment status
   *           cron daily and by every read of the status) derives to expiring
   *           (valid_until within 30 days) or expired (valid_until passed, or
   *           invalid after having been valid): lib/payments/orders/
   *           verification-state.ts.
   *           Or, the first time: the provider has answered not verified
   *           and no form was ever made here (not_started), the company made
   *           a bank payment or a payment file within the last 60 days, and
   *           an account it can pay from needs the verification
   *           (lib/payments/orders/readiness.ts).
   * Done:     the provider answers valid with a new valid_until (a signatory
   *           signed the form), read by the dialog's poll, the page, or the
   *           next sweep; a form is started (the first-time row); or
   *           payments close for the company.
   * A company with nothing on file, or that has not paid a supplier through
   * Accounted for 60 days, is not counted for the first time: it has not
   * shown it pays here, and the Koppla banken step is where it starts.
   */
  'payments_verification_renewal',
  /**
   * Supplier invoices that state bank details the supplier card does not
   * have ("Nya bankuppgifter hos {leverantör}"), one item per invoice: the
   * classic invoice fraud, shown to whoever books invoices, not only to the
   * person who pays. Payment of the invoice is held until it is done.
   * Pending:  an unpaid supplier invoice (registered, approved, partially
   *           paid or overdue; not a credit note) whose stated account
   *           (payee_*) is on none of the supplier card's accounts while the
   *           card has some, or names an account for a supplier the company
   *           has paid before while the card has none, and no person has
   *           decided on that account for that supplier
   *           (lib/payments/payee-alerts.ts listSupplierPayeeAlerts).
   * Done:     a person confirms the account (supplier_payee_confirmations,
   *           which also covers later invoices with it) or rejects it (the
   *           payment then stays held, shown on the invoice), the card is
   *           given the account, or the invoice is paid or credited.
   */
  'supplier_payee_change',
] as const

export type WorklistCategory = (typeof WORKLIST_CATEGORIES)[number]

/**
 * One supplier invoice whose stated bank details wait for a person: the Att
 * göra row "Nya bankuppgifter hos {leverantör}", whose action opens the
 * decision (approve, optionally onto the supplier card, or reject).
 */
export interface SupplierPayeeChangeDue {
  supplier_invoice_id: string
  supplier_id: string
  supplier_name: string
  supplier_invoice_number: string | null
  arrival_number: number | null
  due_date: string
  /** changed: the card has other accounts; new_supplier_account: the card has none, for a supplier paid before. */
  alert: 'changed' | 'new_supplier_account'
  /** Null while nobody decided; rejected keeps the payment held (and the row gone). */
  decision: 'confirmed' | 'rejected' | null
  hold: 'payee_unconfirmed' | 'payee_rejected' | null
  /** The account the supplier card pays today, as a label; null for an empty card. */
  old_payee: string | null
  /** The account the invoice states, as a label. */
  new_payee: string
}

/**
 * The payments verification a company must start or renew: the Att göra row
 * "Verifiera företaget för betalningar via banken" or "Förnya verifieringen
 * för betalningar", which opens Betalningar, where the form is started.
 */
export interface PaymentsVerificationDue {
  state: 'not_started' | 'expiring' | 'expired'
  /** The date the provider holds the verification valid through (ISO date); null when it never said. */
  valid_until: string | null
  /** Whole days left; 0 on the day, negative after; null without a date. */
  days_left: number | null
}

/**
 * One Enable Banking connection the switch campaign still waits for: the Att
 * göra row "Byt bankkopplingen för {bank} senast {date}", which opens Koppla
 * banken in switch mode for exactly that connection.
 */
export interface BankSwitchDue {
  connection_id: string
  bank_name: string
  /** The campaign deadline (ISO date). */
  deadline: string
  /** Whole days left; 0 on the day, negative after. */
  days_left: number
  /** The deadline has passed: the row says the feed has stopped. */
  passed: boolean
  /** Inside 14 days of the deadline, or past it: the row moves to the top. */
  urgent: boolean
}

/**
 * One person the company owes for registered, unpaid utlägg: the Att göra
 * row "Betala ut utlägg till {name}". Grouped server-side by employee_id
 * (or claimant_name for the owner, who has no employee row).
 */
export interface ExpensePayoutDue {
  /** employee_id, or `owner:<claimant_name trimmed and lower-cased>` for claims without one. */
  key: string
  employee_id: string | null
  claimant_name: string
  /** 2893 (AB owner), 2018 (EF owner) or 2820 (employee). */
  liability_account: string
  claim_count: number
  /** The registered claims behind the total, in expense_date order. */
  claim_ids: string[]
  total_sek: number
  /** ISO date of the oldest unpaid claim. */
  oldest_expense_date: string
}

/**
 * One supplier invoice waiting for the signed-in user's attest under the
 * company's attest policy: the Att göra row "Attestera {leverantör}
 * {belopp}". Per person, not per company: only an attester the policy lets
 * attest the invoice, who has not approved it in the current round, gets it.
 * A view of supplier_invoice_approval for one person, so it is not added to
 * the total (the company count already holds the invoice).
 */
export interface SupplierInvoiceAttestDue {
  supplier_invoice_id: string
  supplier_name: string | null
  supplier_invoice_number: string | null
  arrival_number: number
  total: number
  currency: string
  due_date: string
}

/**
 * The next charge Skatteverket will draw that the skattekonto balance does
 * not cover: the Att göra row "Betala in till Skatteverket". Same math as the
 * /skattekonto page's Nästa dragning line and its payment dialog.
 */
export interface SkattekontoPaymentDue {
  /** ISO due date of the charge (forfallodatum, else transaktionsdatum). */
  due: string
  /** Everything Skatteverket draws on `due`, as a positive amount. */
  charge: number
  /** Last synced saldo; null when no balance snapshot exists. */
  balance: number | null
  /**
   * What has to be paid in: charge minus balance, or the full charge when the balance is unknown, less what
   * bank payments to the skattekonto already cover (on their way, or executed after the saldo was fetched).
   * Always above 0: nothing left to pay in is no row at all.
   */
  amount: number
  /** Number of skattekonto rows drawn on `due`. */
  count: number
  /** OCR reference for the payment; null when the company's org number cannot produce one. */
  ocr: string | null
  /** Bankgiro for every skattekonto payment (5050-1055). */
  bankgiro: string
}

export interface WorklistCounts {
  counts: Record<WorklistCategory, number>
  /**
   * Distinct actionable items. Excludes suggested_match, which is a fast
   * path over transactions already counted in book_transaction, and counts
   * the overdue customer invoices as one item (one grouped row), not one per
   * invoice.
   */
  total: number
  /**
   * The grouped overdue row's facts (count, amount, oldest due date), so
   * the row and its count can never disagree after a refetch. Null when
   * nothing is overdue; absent from older payloads.
   */
  overdueInvoices?: OverdueInvoicesDue | null
  /**
   * Where the inbox lives for this company (lib/inkorg/flag.ts inboxHref):
   * the new Inkorg in the rollout, else the workspace under Inköp. The
   * inbox row links here. Absent from older payloads.
   */
  inboxHref?: string
}

/**
 * A company's overdue customer invoices as ONE Att göra row ("N
 * kundfakturor har förfallit", linking to Förfallna), never one row per
 * invoice. The same rows the Förfallna view lists (lib/invoices/overdue.ts),
 * the "Hos inkasso" view's invoices left out.
 */
export interface OverdueInvoicesDue {
  /** Overdue invoices in the group. */
  count: number
  /**
   * What the customers still owe on them, in SEK: remaining_amount for a
   * SEK invoice, the same share of total_sek for one in another currency.
   */
  remaining_sek: number
  /** Invoices in another currency with no SEK amount stored: counted, not summed. */
  unconverted_count: number
  /** YYYY-MM-DD: the earliest due date in the group. */
  oldest_due_date: string
  /** Days the oldest is past due (the day after the due date is day 1). */
  oldest_days_overdue: number
}

/** A transaction↔invoice match suggestion, ready for one-click confirm. */
export interface SuggestedMatch {
  transaction_id: string
  transaction_date: string
  transaction_description: string
  transaction_amount: number
  transaction_currency: string
  /**
   * Which match endpoint confirms it: match-invoice, match-supplier-invoice,
   * match-rot-rut-payout (Skatteverkets utbetalning for an open begäran;
   * candidate_number is then the request name), or match-expense-payout (a
   * transfer repaying one person's registered utlägg; candidate_id is the
   * person key and claim_ids carries the claims the transfer covers).
   */
  kind: 'invoice' | 'supplier_invoice' | 'rot_rut_payout' | 'expense_payout'
  candidate_id: string
  candidate_number: string | null
  counterparty_name: string | null
  candidate_total: number | null
  /**
   * rot_rut_payout only: every begäran the transfer settles. Absent for a
   * persisted 1:1 hint (candidate_id is the request); several when
   * Skatteverket paid a bundle of beslut in one transfer (#2239), in which
   * case candidate_number joins their names.
   */
  request_ids?: string[]
  /** expense_payout only: the registered claims this transfer pays. */
  claim_ids?: string[]
  /**
   * invoice / supplier_invoice only: the row settles SEVERAL open invoices of
   * one counterparty (lib/transactions/invoice-combination.ts), one
   * allocation each at what it still owes, summing to the row. Confirmed in
   * the batch allocation (POST /api/transactions/{id}/match-batch), never
   * one-click; candidate_id is then the first invoice and candidate_number
   * joins their numbers. Absent for a single-invoice hint.
   */
  allocations?: InvoiceSetAllocation[]
}

/**
 * One allocation of a several-invoice suggestion, in the shape the batch
 * allocation dialog takes (lib/transactions/parts-read.ts
 * BatchAllocationPrefill; repeated here so this file stays dependency-free).
 */
export type InvoiceSetAllocation =
  | { kind: 'customer_invoice'; invoice_id: string; amount: number }
  | { kind: 'supplier_invoice'; supplier_invoice_id: string; amount: number }

/**
 * Journal-entry source types that require underlag (BFL 5 kap 7 §). Source
 * types representing system-generated entries (VAT settlement, year-end,
 * currency revaluation, ...) are exempt by omission.
 *
 * Single source of truth for EVERY TS surface (worklist counts, journal-list
 * chip/waiver UI, no-doc-required batch route, push notifications); the SQL
 * mirror lives in the verifikat_without_documents RPC, pinned by
 * tests/pg/document-surfaces-unification.pg.test.ts. Lives here (not in
 * categories.ts) because this module is dependency-free and safe to import
 * from client components.
 */
export const NEEDS_DOC_SOURCE_TYPES = [
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
  // Webshop order bookings rest on the generated orderunderlag (#1881); an
  // entry whose underlag failed to attach must surface here.
  'webshop_order',
  // A point-of-sale day rests on the day report archived at booking
  // (lib/pos-sales/book-day.ts); a verifikat whose report did not attach
  // must surface here.
  'pos_daily_sales',
  // An inbox item booked directly (book-direct) rests on the item's archived
  // document; an item without one (error row, upload that never completed)
  // books a verifikat with no underlag and must surface here (#1317).
  'inbox_item',
] as const
