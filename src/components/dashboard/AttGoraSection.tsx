'use client'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { useFormat } from '@/lib/hooks/use-format'
import { switchDeepLink } from '@/lib/bank-feed/switch-link'
import { useCapability, useCompany } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { visibleWorklistTotal } from '@/lib/worklist/visible-total'
import type { AiTaskCategory } from '@/lib/worklist/ai-task'
import type { DocumentToSignDue, PaymentFailedDue, PaymentsVerificationDue, SuggestedMatch, SupplierPayeeChangeDue } from '@/lib/worklist/types'
import { PayeeChangeDialog } from '@/components/payments/PayeeChangeDialog'
import type { AllocationTransaction } from '@/components/transactions/MatchAllocationDialog'
import { PAYMENTS_PAGE_PATH } from '@/lib/payments/orders/page-path'
import { failedPaymentReasonText, type BankPaymentsTranslator } from '@/lib/payments/orders/failed-payment-reason'
import type { MissingUnderlagSample } from '@/lib/worklist/missing-underlag'
import { NO_AI_CONNECTION, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { AiTaskAction } from './AiTaskAction'
import { KopplingarChips } from './KopplingarChips'
import { SuggestionCards } from './SuggestionCards'
import { GrantPostings } from './GrantPostings'
import type { GrantReview } from '@/lib/grants/types'
import type { OpenSuggestion } from '@/lib/suggestions/types'
import { BATCH_REVIEW_HREF, batchRowKey } from '@/lib/collections/batch-dialog'
import { HandoverBatchDialog } from '@/components/collections/HandoverBatchDialog'
import { usePendingCollectionsRun } from '@/components/collections/collections-run-client'
import { capitalizeFirst } from '@/components/collections/collections-client'
import { REMINDER_BATCH_REVIEW_HREF } from '@/lib/reminders/batch-dialog'
import { ReminderBatchDialog } from '@/components/reminders/ReminderBatchDialog'
import { usePendingReminderBatch } from '@/components/reminders/reminder-batch-client'
import {
  ArrowsRightLeftIcon,
  BanknotesIcon,
  BellAlertIcon,
  BookOpenIcon,
  BuildingLibraryIcon,
  CalendarDaysIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  DocumentMagnifyingGlassIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  InboxIcon,
  LinkIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
} from '@/components/icons'
import type {
  AttestedToPayDue,
  BankSwitchDue,
  ExpensePayoutDue,
  SkattekontoPaymentDue,
  SupplierInvoiceAttestDue,
  WorklistCounts,
} from '@/lib/worklist/types'

// Loaded when a several-invoice row's "Matcha" is pressed, not with Hem.
const MatchAllocationDialog = dynamic(() => import('@/components/transactions/MatchAllocationDialog'))

/**
 * AttGoraSection: the dashboard's unified worklist ("Att göra").
 *
 * One flat ledger of everything actionable, grouped into four bands by
 * session intent: Bokför (the daily loop), Betala (money the company owes a
 * person for utlägg), Granska & komplettera (close the gaps), Bevaka
 * (time-driven). Every count comes from lib/worklist (the same
 * source as the sidebar badges) so the numbers can never disagree.
 *
 * Suggested transaction↔invoice matches are one Bokför row with their count
 * (lib/worklist suggested_match), leading to Transaktioner, whose inbox lists
 * the rows with a match first. They are a subset of the transactions the row
 * above counts, so the row carries no list of its own. The exception is a
 * payment that settles several invoices of one counterparty (PH 192): the
 * inbox has no hint for it, so it is its own row here, and "Matcha" opens
 * the batch allocation with the invoices already picked.
 */

interface ExpiringBankConnection {
  id: string
  bank_name: string
  days_left: number
}

interface AttGoraSectionProps {
  worklist: WorklistCounts
  /** People owed for registered, unpaid utlägg: one Betala row each. */
  expensePayouts?: ExpensePayoutDue[]
  /**
   * Supplier invoices waiting for this user's attest under the attest policy
   * (lib/worklist listSupplierInvoiceAttestsDue): one Granska row each,
   * "Attestera {leverantör} {belopp}", above the company's attest count.
   */
  attestsDue?: SupplierInvoiceAttestDue[]
  /**
   * Documents waiting for this user's BankID signature (lib/worklist
   * documents_to_sign): one Granska row each, "Signera {rubrik}", opening the
   * member signing page.
   */
  documentsToSign?: DocumentToSignDue[]
  /** The next skattekonto charge the balance does not cover: one Betala row. */
  skattekontoPayment?: SkattekontoPaymentDue | null
  /**
   * Supplier invoices the attesters released for payment (lib/worklist
   * attested_to_pay): one Betala row, "Betala N attesterade fakturor".
   */
  attestedToPay?: AttestedToPayDue | null
  /**
   * Bank connections still to switch from Enable Banking to Open Payments
   * (lib/worklist bank_switch): one row each, in Bevaka while the deadline
   * is far, at the top of the list inside 14 days and once it has passed.
   */
  bankSwitches?: BankSwitchDue[]
  /**
   * The payments verification (know your customer at the payment provider)
   * to renew (lib/worklist payments_verification_renewal): one row, in Bevaka
   * while it is expiring, at the top once it has lapsed and payments stop.
   */
  paymentsVerification?: PaymentsVerificationDue | null
  /**
   * Supplier invoices stating bank details the supplier card lacks, that
   * nobody has decided on (lib/worklist supplier_payee_change): one row each
   * at the top of the list, with the decision behind "Granska". Payment of
   * each is held until it is decided.
   */
  supplierPayeeChanges?: SupplierPayeeChangeDue[]
  /**
   * Supplier invoices whose newest bank payment the bank rejected or that
   * failed, still to pay (lib/worklist payment_failed): one row each at the
   * top of the list, opening the invoice, where it is paid again.
   */
  paymentsFailed?: PaymentFailedDue[]
  /**
   * Bank rows that settle several open invoices of one counterparty
   * (lib/worklist listSuggestedMatches, the matches carrying `allocations`):
   * one Bokför row each, "Betalningen matchar 2 fakturor från X", whose
   * "Matcha" opens the batch allocation (MatchAllocationDialog) prefilled.
   * They are part of counts.suggested_match, so the generic row counts the
   * rest.
   */
  invoiceSets?: SuggestedMatch[]
  /**
   * Open suggestions (lib/worklist suggestion; lib/suggestions/list.ts): at
   * most three Förslag cards, ranked, each answered with Ja, Inte nu or Visa
   * aldrig. The customer's agent finds the same three in its briefing.
   */
  suggestions?: OpenSuggestion[]
  /**
   * What the company's rules for automatic booking (lib/grants) let an agent
   * book without asking, since someone last marked it reviewed: the
   * "Bokfört enligt regel" band, with Ångra per posting and Återkalla per
   * rule. Absent or empty for a company without grants (nearly all).
   */
  grantReview?: GrantReview | null
  expiringBankConnections?: ExpiringBankConnection[]
  /**
   * True while the setup checklist is open and the company has zero posted
   * journal entries. An empty ledger is not an achievement: the all-clear
   * state then says "nothing here yet" instead of a false "all caught up".
   */
  emptyLedger?: boolean
  /**
   * False when the company has no active bank connection. The all-clear state
   * then explains that nothing flows in automatically and offers "Anslut bank"
   * instead of a bare "all caught up": for a disconnected company the silence
   * is a setup gap, not an achievement. Defaults to true so a fetch error
   * degrades to the ordinary all-clear copy, never to a wrong nag.
   */
  hasActiveBankConnection?: boolean
  /**
   * This user's agent connection over MCP OAuth (lib/onboarding/ai-clients).
   * `connected` drives the kopplingar chip; the row's AI action hands work
   * only to one of the verified `clients`.
   */
  aiConnection?: AiConnection
  /**
   * The connected client to ask for a first task, while no agent of this user
   * has worked (lib/onboarding/ai-clients firstTaskClient). Shown past the
   * checklist gate: the checklist ticks its step at the sign-in, and nothing
   * else on the page asks for the first question.
   */
  firstTaskClient?: AiClient | null
  /**
   * What the biggest missing underlag actually need fetching from, derived
   * from the same page of rows the count comes from (lib/worklist/
   * missing-underlag). Renders as the row's detail line so the errand is
   * visible before anyone opens a chat, and with no chat having run.
   */
  missingUnderlag?: MissingUnderlagSample
  /** False when no Skatteverket token is stored: the kopplingar chip offers the connect. */
  hasSkatteverketConnection?: boolean
  /** Accounted can be appointed as ombud at Skatteverket (system auth on). */
  skvOmbudEnabled?: boolean
  /**
   * Whether to render the kopplingar row under the list. Off while the
   * getting-started checklist is open: it carries the bank and Skatteverket
   * steps itself, and the row would repeat them.
   */
  showKopplingar?: boolean
}

interface WorklistRowProps {
  href: string
  icon: React.ComponentType<{ className?: string }>
  label: string
  /** Data for this row (amounts, dates, who): a second muted line. */
  detail?: string
  /**
   * What the row means, for whoever wonders: a hover title on the label,
   * never a second line. Explanations in the list flow are the clutter
   * conventions 4 and 7 exist to prevent.
   */
  hint?: string
  /** Omitted where the row's detail or amount already says how many. */
  count?: number
  badge?: React.ReactNode
  /** The row's own control (the "Gör i Claude" pill); sits above the stretched link. */
  action?: React.ReactNode
  /**
   * Open the row's work in place (a dialog) instead of following the link;
   * the link stays for a new tab and as the fallback.
   */
  onSelect?: () => void
}

function WorklistRow({ href, icon: Icon, label, detail, hint, count, badge, action, onSelect }: WorklistRowProps) {
  // The label is the link, stretched over the row with a pseudo-element, so
  // the pill can be a real button beside it instead of a button inside an
  // anchor. The pill sits above the stretched area (relative z-10).
  return (
    <div className="group relative flex w-full items-start gap-3 border-b border-border px-1 py-3.5 transition-colors duration-150 hover:bg-secondary/35">
      <span className="mt-px w-[18px] shrink-0 text-muted-foreground" aria-hidden>
        <Icon className="h-[15px] w-[15px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px]">
          <Link
            href={href}
            title={hint}
            onClick={
              onSelect
                ? (e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                    e.preventDefault()
                    onSelect()
                  }
                : undefined
            }
            className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
          >
            {label}
          </Link>
        </p>
        {detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
      <span className="ml-auto flex shrink-0 items-center gap-2.5 pt-px">
        {badge}
        {/* The action sits before the count so every count lines up in one
            column at the row's edge, with or without an action. -my-1.5
            centres the h-8 button on the 20px text line without making
            rows that carry one taller than rows that don't. */}
        {action && <span className="relative z-10 -my-1.5 flex items-center">{action}</span>}
        {/* A plain count, not a chip: every row has one, and a chip on
            every row marks nothing (convention 5). */}
        {count !== undefined && (
          <span className="min-w-[3ch] text-right text-xs tabular-nums text-muted-foreground">{count}</span>
        )}
        <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
      </span>
    </div>
  )
}

function BandHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-1 pt-5 pb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
      {children}
    </p>
  )
}

export default function AttGoraSection({
  worklist,
  expensePayouts = [],
  attestsDue = [],
  documentsToSign = [],
  skattekontoPayment = null,
  attestedToPay = null,
  bankSwitches = [],
  paymentsVerification = null,
  supplierPayeeChanges = [],
  paymentsFailed = [],
  invoiceSets = [],
  suggestions = [],
  grantReview = null,
  expiringBankConnections = [],
  emptyLedger = false,
  hasActiveBankConnection = true,
  aiConnection = NO_AI_CONNECTION,
  firstTaskClient = null,
  missingUnderlag,
  hasSkatteverketConnection = false,
  skvOmbudEnabled = false,
  showKopplingar = false,
}: AttGoraSectionProps) {
  const t = useTranslations('dashboard')
  const tCollections = useTranslations('collections')
  const tReminders = useTranslations('reminders')
  const tAttest = useTranslations('att_gora_attest')
  const tBankPayments = useTranslations('bank_payments')
  const router = useRouter()
  const { formatDateLong } = useFormat()
  // The Dokumentinkorg is a paid (AI) surface: a non-payer's home to-do list
  // must not offer a row that jumps to the gated workspace. Mirrors the sidebar
  // + command palette gate; the page itself enforces it server-side.
  const hasAi = useCapability(CAPABILITY.ai)

  const [counts, setCounts] = useState(worklist.counts)
  // The daily collections run: a collections row that opens its review
  // dialog in place, named for the step it proposes, never an agent proposal.
  const { company } = useCompany()
  const collectionsRun = usePendingCollectionsRun(company?.id, counts.collection_batch_ready > 0)
  const [collectionsRunOpen, setCollectionsRunOpen] = useState(false)
  // The day's reminders: the same, a row that opens their review dialog in
  // place. The open dialog holds its operation id, so it stays on its result
  // after the approval while the row and the batch go away behind it.
  const reminderBatch = usePendingReminderBatch(company?.id, counts.reminder_batch_ready > 0)
  const reminderBatchId = reminderBatch.batch?.id ?? null
  const [reviewingReminderBatchId, setReviewingReminderBatchId] = useState<string | null>(null)
  const [total, setTotal] = useState(worklist.total)
  // The grouped overdue row's facts, refreshed with the counts so its
  // count, amount and date never disagree.
  const [overdueInvoices, setOverdueInvoices] = useState(worklist.overdueInvoices ?? null)
  const [payeeChanges, setPayeeChanges] = useState(supplierPayeeChanges)
  const [openSuggestions, setOpenSuggestions] = useState(suggestions)
  const [reviewingPayeeId, setReviewingPayeeId] = useState<string | null>(null)
  const [invoiceSetRows, setInvoiceSetRows] = useState(invoiceSets)
  // The several-invoice row whose batch allocation is open.
  const [allocating, setAllocating] = useState<SuggestedMatch | null>(null)
  // One object per opening: the dialog reloads its candidates when it changes.
  const allocatingTransaction = useMemo<AllocationTransaction | null>(
    () =>
      allocating
        ? {
            id: allocating.transaction_id,
            amount: allocating.transaction_amount,
            currency: allocating.transaction_currency,
            date: allocating.transaction_date,
            description: allocating.transaction_description,
          }
        : null,
    [allocating],
  )
  // A router.refresh() (RefreshWhenRestored) hands this mounted section a new
  // server render: take its numbers instead of keeping the first ones. Same
  // adjust-state-during-render pattern as DashboardNav.
  const [renderedWorklist, setRenderedWorklist] = useState(worklist)
  if (worklist !== renderedWorklist) {
    setRenderedWorklist(worklist)
    setCounts(worklist.counts)
    setTotal(worklist.total)
    setOverdueInvoices(worklist.overdueInvoices ?? null)
    setPayeeChanges(supplierPayeeChanges)
    setInvoiceSetRows(invoiceSets)
    setOpenSuggestions(suggestions)
  }

  async function refetchCounts() {
    try {
      const res = await fetch('/api/worklist/counts')
      if (!res.ok) throw new Error(`worklist counts refetch failed: ${res.status}`)
      const json = (await res.json().catch(() => ({}))) as { data?: WorklistCounts }
      if (json.data) {
        setCounts(json.data.counts)
        setTotal(json.data.total)
        setOverdueInvoices(json.data.overdueInvoices ?? null)
      }
    } catch (err) {
      // Stale counts self-correct on the next page load: never block the
      // flow. Note this is a browser console.error and nothing collects it:
      // the observability sink (lib/observability) is server-side and has no
      // client adapter, so a systematically broken counts endpoint currently
      // hides behind silently frozen numbers until someone reports it.
      console.error('[att-gora] worklist counts refetch failed', err)
    }
  }

  const showInboxDocuments = hasAi && counts.inbox_document > 0
  // The several-invoice rows have their own lines; the generic row counts
  // the single-invoice matches the Transaktioner inbox lists first.
  const otherSuggestedMatches = Math.max(0, counts.suggested_match - invoiceSetRows.length)
  const bokforRows =
    counts.book_transaction > 0 ||
    counts.book_skattekonto > 0 ||
    showInboxDocuments ||
    invoiceSetRows.length > 0 ||
    otherSuggestedMatches > 0
  const betalaRows = expensePayouts.length > 0 || skattekontoPayment !== null || attestedToPay !== null
  const granskaRows =
    documentsToSign.length > 0 ||
    attestsDue.length > 0 ||
    counts.supplier_invoice_approval > 0 ||
    counts.verifikat_missing_document > 0 ||
    counts.pending_operations > 0 ||
    counts.document_relevance > 0 ||
    counts.document_unclassified > 0 ||
    counts.document_field_review > 0 ||
    counts.arkiv_finding > 0 ||
    counts.peppol_delivery_failed > 0 ||
    counts.collection_decision > 0 ||
    counts.collection_attention > 0 ||
    counts.collection_settlements_to_book > 0 ||
    counts.collected_payments_to_book > 0 ||
    counts.collection_batch_ready > 0 ||
    counts.reminder_batch_ready > 0
  // The switch rows: urgent ones (inside 14 days, or past the deadline) lead
  // the list under their own band; the rest wait in Bevaka with the other
  // time-driven items.
  const urgentSwitches = bankSwitches.filter((b) => b.urgent)
  const calmSwitches = bankSwitches.filter((b) => !b.urgent)
  // The verification row follows the same split: expiring, and the first
  // verification of a company that pays by file, wait in Bevaka; expired
  // (payments refused) leads the list.
  const verificationExpired = paymentsVerification?.state === 'expired' ? paymentsVerification : null
  const verificationCalm = paymentsVerification && paymentsVerification.state !== 'expired' ? paymentsVerification : null
  const bevakaRows =
    overdueInvoices !== null ||
    counts.deadline_action > 0 ||
    counts.agreement_payment_missed > 0 ||
    counts.reconciliation_due > 0 ||
    calmSwitches.length > 0 ||
    verificationCalm !== null ||
    expiringBankConnections.length > 0
  // Shown while anything waits for a look, or while the rules are paused (so
  // the switch to turn them back on stays in reach).
  const grantRows = !!grantReview && (grantReview.postings.length > 0 || grantReview.paused)
  const allClear =
    !bokforRows &&
    !betalaRows &&
    !granskaRows &&
    openSuggestions.length === 0 &&
    !grantRows &&
    !bevakaRows &&
    urgentSwitches.length === 0 &&
    verificationExpired === null &&
    payeeChanges.length === 0 &&
    paymentsFailed.length === 0

  // The header total must equal what the section actually shows, computed off
  // the same visibleWorklistTotal helper as the dashboard KPI tile so the two
  // can never drift: the hidden paid inbox row is subtracted for non-payers,
  // else the header would count work the section no longer renders.
  const displayTotal = visibleWorklistTotal({
    total,
    inboxDocumentCount: counts.inbox_document,
    hasAi,
    extra: expiringBankConnections.length,
  })
  // The row's AI action, once a client is connected: today only
  // Kvittojakten on "Verifikat utan underlag" (AiTaskAction renders nothing
  // for the other categories).
  const aiAction = (category: AiTaskCategory, count: number) =>
    <AiTaskAction clients={aiConnection.clients} task={{ category, count }} />

  // Where the biggest missing underlag actually have to be fetched from, in
  // one line, derived from the ledger rather than reported back by an agent.
  // Silent when the answer is "look in your mail": that is what "Verifikat
  // utan underlag" already says, and a detail line on every row is the bug
  // convention 5 exists to prevent.
  const topMissingUnderlag = missingUnderlag?.top
  const missingUnderlagDetail =
    topMissingUnderlag && topMissingUnderlag.kind !== 'mail'
      ? t(`missing_underlag_next_${topMissingUnderlag.kind}`, { count: topMissingUnderlag.count })
      : undefined

  // The payments verification to start or renew: the deep link opens
  // Betalningar, whose header starts the form. A chip counts the days while it
  // is expiring and says so once it has lapsed (an exception, so a chip;
  // convention 5); the first verification has no chip.
  const verificationRow = (item: PaymentsVerificationDue) => (
    <WorklistRow
      key="payments-verification"
      href={PAYMENTS_PAGE_PATH}
      icon={ShieldCheckIcon}
      label={
        item.state === 'not_started'
          ? t('row_payments_verification_start')
          : item.state === 'expired'
            ? t('row_payments_verification_expired')
            : t('row_payments_verification_expiring')
      }
      hint={item.state === 'not_started' ? t('row_payments_verification_start_detail') : t('row_payments_verification_detail')}
      badge={
        item.state === 'not_started' ? undefined : item.state === 'expired' ? (
          <Badge variant="destructive">{t('payments_verification_expired_badge')}</Badge>
        ) : item.days_left !== null ? (
          <Badge variant="warning">{t('payments_verification_days_left', { days: Math.max(item.days_left, 0) })}</Badge>
        ) : undefined
      }
    />
  )

  // One row per bank row that settles several invoices of one counterparty
  // (PH 192): the label opens the row in Transaktioner, "Matcha" the batch
  // allocation with the invoices picked, confirmed there before anything is
  // booked.
  const invoiceSetRow = (item: SuggestedMatch) => {
    const count = item.allocations?.length ?? 0
    const receipt = item.kind === 'invoice'
    const label = item.counterparty_name
      ? t(receipt ? 'row_invoice_set_receipt' : 'row_invoice_set_payment', { count, name: item.counterparty_name })
      : t(receipt ? 'row_invoice_set_receipt_unnamed' : 'row_invoice_set_payment_unnamed', { count })
    return (
      <WorklistRow
        key={`invoice-set-${item.transaction_id}`}
        href={`/transactions?highlight=${item.transaction_id}`}
        icon={LinkIcon}
        label={label}
        hint={t('row_invoice_set_hint')}
        detail={
          item.candidate_number
            ? t('row_invoice_set_detail', { date: formatDate(item.transaction_date), invoices: item.candidate_number })
            : formatDate(item.transaction_date)
        }
        badge={
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatCurrency(Math.abs(item.transaction_amount), item.transaction_currency)}
          </span>
        }
        action={
          <Button size="sm" variant="outline" onClick={() => setAllocating(item)}>
            {t('invoice_set_match')}
          </Button>
        }
      />
    )
  }

  // One row per supplier invoice whose bank details wait for a decision: the
  // label opens the invoice, "Granska" the decision itself. A changed account
  // is the classic invoice fraud, so the rows lead the list (band Nu).
  const payeeChangeRow = (item: SupplierPayeeChangeDue) => (
    <WorklistRow
      key={`payee-${item.supplier_invoice_id}`}
      href={`/supplier-invoices/${item.supplier_invoice_id}`}
      icon={ShieldExclamationIcon}
      label={t('row_supplier_payee_change', { supplier: item.supplier_name })}
      detail={
        item.old_payee
          ? t('row_supplier_payee_change_detail', { invoice: item.supplier_invoice_number ?? `#${item.arrival_number ?? ''}`, payee: item.new_payee, card: item.old_payee })
          : t('row_supplier_payee_new_detail', { invoice: item.supplier_invoice_number ?? `#${item.arrival_number ?? ''}`, payee: item.new_payee })
      }
      action={
        <Button size="sm" variant="outline" onClick={() => setReviewingPayeeId(item.supplier_invoice_id)}>
          {t('supplier_payee_review')}
        </Button>
      }
    />
  )

  // One row per supplier invoice whose bank payment did not go through: the
  // label opens the invoice, where Betala via banken (or the betalfil) pays
  // it again, with the bank's reason (failedPaymentReasonText, the mail's
  // rule too). The supplier is not paid, so the rows lead the list (band Nu).
  const paymentFailedRow = (item: PaymentFailedDue) => {
    const reason = failedPaymentReasonText(tBankPayments as unknown as BankPaymentsTranslator, item.status, item.reason_code)
    const invoice = item.supplier_invoice_number?.trim() || (item.arrival_number != null ? `#${item.arrival_number}` : null)
    return (
      <WorklistRow
        key={`payment-failed-${item.supplier_invoice_id}`}
        href={`/supplier-invoices/${item.supplier_invoice_id}`}
        icon={ExclamationTriangleIcon}
        label={t('row_payment_failed', { payee: item.payee_name })}
        hint={t('row_payment_failed_hint')}
        detail={invoice ? t('row_payment_failed_detail', { invoice, reason }) : reason}
        badge={<span className="text-xs tabular-nums text-muted-foreground">{formatCurrency(item.amount, item.currency)}</span>}
      />
    )
  }

  // One row per connection to switch: the deep link opens Koppla banken in
  // switch mode for exactly that row. Past the deadline the row says the
  // feed has stopped; inside 14 days a chip counts the days (an exception,
  // so a chip; convention 5).
  const switchRow = (item: BankSwitchDue) => (
    <WorklistRow
      key={item.connection_id}
      href={switchDeepLink(item.connection_id)}
      icon={BuildingLibraryIcon}
      label={
        item.passed
          ? t('row_bank_switch_stopped', { bank: item.bank_name })
          : t('row_bank_switch', { bank: item.bank_name, date: formatDateLong(item.deadline) })
      }
      hint={t('row_bank_switch_detail')}
      badge={
        item.passed ? (
          <Badge variant="destructive">{t('bank_switch_stopped_badge')}</Badge>
        ) : item.urgent ? (
          <Badge variant="warning">{t('bank_switch_days_left', { days: Math.max(item.days_left, 0) })}</Badge>
        ) : undefined
      }
    />
  )

  return (
    <section aria-label={t('att_gora_title')}>
      {/* Pane header: Geist title + quiet count over a hairline */}
      <div className="flex items-baseline justify-between border-b border-border px-1 pb-2.5">
        <h2 className="font-sans text-sm font-medium">{t('att_gora_title')}</h2>
        <p className="text-xs text-muted-foreground tabular-nums" role="status" aria-live="polite">
          {allClear
            ? emptyLedger
              ? t('att_gora_new_status')
              : t('all_done')
            : t('att_gora_left', { count: displayTotal })}
        </p>
      </div>

      <div>
          {allClear ? (
            // One quiet line, not a hero: the kopplingar row under it is what
            // an empty list should draw the eye to (founder direction 2026-09-14).
            <div className="flex items-center gap-3 border-b border-border px-1 py-3.5 text-[13px] text-muted-foreground">
              <span className="flex w-[18px] shrink-0 justify-center" aria-hidden>
                {emptyLedger
                  ? <BookOpenIcon className="h-[15px] w-[15px]" />
                  : <CheckCircleIcon className="h-[15px] w-[15px]" />}
              </span>
              {emptyLedger ? t('att_gora_new_body') : t('att_gora_empty_body')}
            </div>
          ) : (
            <div className="pb-2">
              {(urgentSwitches.length > 0 || verificationExpired || payeeChanges.length > 0 || paymentsFailed.length > 0) && (
                <div>
                  <BandHeader>{t('band_now')}</BandHeader>
                  <div>
                    {paymentsFailed.map(paymentFailedRow)}
                    {payeeChanges.map(payeeChangeRow)}
                    {verificationExpired && verificationRow(verificationExpired)}
                    {urgentSwitches.map(switchRow)}
                  </div>
                </div>
              )}

              {bokforRows && (
                <div>
                  <BandHeader>{t('band_bokfor')}</BandHeader>
                  <div>
                    {counts.book_transaction > 0 && (
                      <WorklistRow
                        href="/transactions"
                        action={aiAction('book_transaction', counts.book_transaction)}
                        icon={ArrowsRightLeftIcon}
                        label={t('row_book_transactions')}
                        count={counts.book_transaction}
                      />
                    )}
                    {counts.book_skattekonto > 0 && (
                      <WorklistRow
                        href="/transactions?source=skatteverket"
                        action={aiAction('book_skattekonto', counts.book_skattekonto)}
                        icon={BuildingLibraryIcon}
                        label={t('row_book_skattekonto')}
                        count={counts.book_skattekonto}
                      />
                    )}
                    {invoiceSetRows.map(invoiceSetRow)}
                    {otherSuggestedMatches > 0 && (
                      <WorklistRow
                        href="/transactions"
                        icon={LinkIcon}
                        label={t('row_suggested_matches')}
                        count={otherSuggestedMatches}
                      />
                    )}
                    {showInboxDocuments && (
                      <WorklistRow
                        // The company's inbox: the new Inkorg in the rollout, else the workspace under Inköp.
                        href={worklist.inboxHref ?? LEGACY_INBOX_HREF}
                        action={aiAction('inbox_document', counts.inbox_document)}
                        icon={InboxIcon}
                        label={t('row_inbox_documents')}
                        hint={t('row_inbox_documents_detail')}
                        count={counts.inbox_document}
                      />
                    )}
                  </div>
                </div>
              )}

              {betalaRows && (
                <div>
                  <BandHeader>{t('band_betala')}</BandHeader>
                  <div>
                    {attestedToPay && (
                      <WorklistRow
                        href="/supplier-invoices?tab=to_pay"
                        icon={BanknotesIcon}
                        label={t('row_attested_to_pay', { count: attestedToPay.count })}
                        detail={
                          attestedToPay.overdue > 0
                            ? t('row_attested_to_pay_detail_overdue', {
                                overdue: attestedToPay.overdue,
                                date: formatDate(attestedToPay.next_due),
                              })
                            : t('row_attested_to_pay_detail', { date: formatDate(attestedToPay.next_due) })
                        }
                      />
                    )}
                    {skattekontoPayment && (
                      <WorklistRow
                        href="/skattekonto?betala=1"
                        icon={BuildingLibraryIcon}
                        label={t('row_skattekonto_payment')}
                        detail={
                          skattekontoPayment.ocr
                            ? t('row_skattekonto_payment_detail', {
                                bankgiro: skattekontoPayment.bankgiro,
                                ocr: skattekontoPayment.ocr,
                                date: formatDate(skattekontoPayment.due),
                              })
                            : t('row_skattekonto_payment_detail_no_ocr', {
                                bankgiro: skattekontoPayment.bankgiro,
                                date: formatDate(skattekontoPayment.due),
                              })
                        }
                        badge={
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatCurrency(skattekontoPayment.amount)}
                          </span>
                        }
                      />
                    )}
                    {expensePayouts.map((p) => (
                      <WorklistRow
                        key={p.key}
                        href="/expenses"
                        icon={BanknotesIcon}
                        label={t('row_expense_payout', { name: p.claimant_name })}
                        detail={
                          p.claim_count === 1
                            ? t('row_expense_payout_detail_one', { date: formatDate(p.oldest_expense_date) })
                            : t('row_expense_payout_detail_other', {
                                count: p.claim_count,
                                date: formatDate(p.oldest_expense_date),
                              })
                        }
                        badge={
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatCurrency(p.total_sek)}
                          </span>
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {granskaRows && (
                <div>
                  <BandHeader>{t('band_granska')}</BandHeader>
                  <div>
                    {documentsToSign.map((d) => (
                      <WorklistRow
                        key={`sign-${d.signer_id}`}
                        href={`/signering/${d.signer_id}`}
                        icon={PencilSquareIcon}
                        label={t('row_document_to_sign', { title: d.title })}
                        detail={
                          d.role_label
                            ? t('row_document_to_sign_detail_role', { role: d.role_label, date: formatDateLong(d.expires_at) })
                            : t('row_document_to_sign_detail', { date: formatDateLong(d.expires_at) })
                        }
                      />
                    ))}
                    {attestsDue.map((a) => (
                      <WorklistRow
                        key={a.supplier_invoice_id}
                        href={`/supplier-invoices/${a.supplier_invoice_id}`}
                        icon={CheckBadgeIcon}
                        label={tAttest('row_label', {
                          supplier: a.supplier_name ?? tAttest('supplier_fallback'),
                          amount: formatCurrency(a.total, a.currency),
                        })}
                        detail={tAttest('row_detail', { date: formatDate(a.due_date) })}
                      />
                    ))}
                    {/* The agent's proposals lead the company-wide rows: they
                        are fresh work the agent is blocked on, and /pending is
                        what people open most from Hem (14 days to 2026-10-28:
                        397 users via the nav, 110 via this row). */}
                    {counts.pending_operations > 0 && (
                      <WorklistRow
                        href="/pending"
                        icon={ShieldCheckIcon}
                        label={t('row_pending_ops')}
                        count={counts.pending_operations}
                      />
                    )}
                    {counts.supplier_invoice_approval > 0 && (
                      <WorklistRow
                        href="/supplier-invoices?tab=registered"
                        action={aiAction('supplier_invoice_approval', counts.supplier_invoice_approval)}
                        icon={CheckBadgeIcon}
                        label={t('row_supplier_approval')}
                        count={counts.supplier_invoice_approval}
                      />
                    )}
                    {counts.verifikat_missing_document > 0 && (
                      <WorklistRow
                        href="/bookkeeping?missingUnderlag=true"
                        action={aiAction('verifikat_missing_document', counts.verifikat_missing_document)}
                        icon={ExclamationTriangleIcon}
                        label={t('row_missing_underlag')}
                        detail={missingUnderlagDetail}
                        count={counts.verifikat_missing_document}
                      />
                    )}
                    {counts.document_relevance > 0 && (
                      <WorklistRow
                        href="/arkiv"
                        icon={DocumentMagnifyingGlassIcon}
                        label={t('row_document_relevance')}
                        hint={t('row_document_relevance_detail')}
                        count={counts.document_relevance}
                      />
                    )}
                    {counts.document_unclassified > 0 && (
                      <WorklistRow
                        href="/arkiv/granska#typ"
                        icon={DocumentMagnifyingGlassIcon}
                        label={t('row_document_unclassified')}
                        count={counts.document_unclassified}
                      />
                    )}
                    {counts.document_field_review > 0 && (
                      <WorklistRow
                        href="/arkiv/granska#falt"
                        icon={DocumentMagnifyingGlassIcon}
                        label={t('row_document_field_review')}
                        hint={t('row_document_field_review_detail')}
                        count={counts.document_field_review}
                      />
                    )}
                    {counts.arkiv_finding > 0 && (
                      <WorklistRow
                        href="/arkiv/granska#fynd"
                        icon={DocumentMagnifyingGlassIcon}
                        label={t('row_arkiv_finding')}
                        hint={t('row_arkiv_finding_detail')}
                        count={counts.arkiv_finding}
                      />
                    )}
                    {counts.peppol_delivery_failed > 0 && (
                      <WorklistRow
                        href="/invoices"
                        icon={PaperAirplaneIcon}
                        label={t('row_peppol_delivery_failed')}
                        hint={t('row_peppol_delivery_failed_detail')}
                        count={counts.peppol_delivery_failed}
                      />
                    )}
                    {counts.collection_decision > 0 && (
                      <WorklistRow
                        href="/invoices?status=collections"
                        icon={ScaleIcon}
                        label={t('row_collection_decision')}
                        hint={t('row_collection_decision_detail')}
                        count={counts.collection_decision}
                      />
                    )}
                    {counts.collection_attention > 0 && (
                      <WorklistRow
                        href="/invoices?status=collections"
                        icon={ScaleIcon}
                        label={t('row_collection_attention')}
                        hint={t('row_collection_attention_detail')}
                        count={counts.collection_attention}
                      />
                    )}
                    {counts.collection_settlements_to_book > 0 && (
                      <WorklistRow
                        href="/invoices/settlements"
                        icon={BanknotesIcon}
                        label={t('row_collection_settlements_to_book')}
                        hint={t('row_collection_settlements_to_book_detail')}
                        count={counts.collection_settlements_to_book}
                      />
                    )}
                    {counts.collected_payments_to_book > 0 && (
                      <WorklistRow
                        href="/invoices/settlements"
                        icon={BanknotesIcon}
                        label={t('row_collected_payments_to_book')}
                        hint={t('row_collected_payments_to_book_detail')}
                        count={counts.collected_payments_to_book}
                      />
                    )}
                    {counts.collection_batch_ready > 0 && (
                      <WorklistRow
                        href={BATCH_REVIEW_HREF}
                        onSelect={collectionsRun.run ? () => setCollectionsRunOpen(true) : undefined}
                        icon={ScaleIcon}
                        label={capitalizeFirst(
                          tCollections(batchRowKey(collectionsRun.run?.items ?? []), { count: counts.collection_batch_ready }),
                        )}
                        hint={t('row_collection_batch_cta')}
                      />
                    )}
                    {counts.reminder_batch_ready > 0 && (
                      <WorklistRow
                        href={REMINDER_BATCH_REVIEW_HREF}
                        onSelect={reminderBatchId ? () => setReviewingReminderBatchId(reminderBatchId) : undefined}
                        icon={BellAlertIcon}
                        label={tReminders('batch_row', { count: counts.reminder_batch_ready })}
                        hint={t('row_reminder_batch_cta')}
                      />
                    )}
                  </div>
                </div>
              )}

              {openSuggestions.length > 0 && (
                <div>
                  <BandHeader>{t('band_suggestions')}</BandHeader>
                  <SuggestionCards
                    suggestions={openSuggestions}
                    onResolved={(answered) => {
                      setOpenSuggestions((prev) => prev.filter((s) => s.suggestion_id !== answered.suggestion_id))
                      void refetchCounts()
                    }}
                  />
                </div>
              )}

              {grantRows && grantReview && (
                <div>
                  <BandHeader>{t('band_grant_postings')}</BandHeader>
                  {/* Keyed by what the server sent, so a refreshed render resets the list. */}
                  <GrantPostings
                    key={`${grantReview.paused ? 'p' : 'a'}:${grantReview.postings.map((p) => p.use_id).join(',')}`}
                    review={grantReview}
                    onChanged={() => router.refresh()}
                  />
                </div>
              )}

              {bevakaRows && (
                <div>
                  <BandHeader>{t('band_bevaka')}</BandHeader>
                  <div>
                    {counts.deadline_action > 0 && (
                      <WorklistRow
                        href="/deadlines"
                        action={aiAction('deadline_action', counts.deadline_action)}
                        icon={CalendarDaysIcon}
                        label={t('row_deadlines')}
                        count={counts.deadline_action}
                      />
                    )}
                    {/* One row for all of the company's overdue customer
                        invoices (lib/worklist OverdueInvoicesDue), after the
                        tax deadlines: a fact and where to act, landing on
                        Förfallna, the view that lists the same invoices. */}
                    {overdueInvoices && (
                      <WorklistRow
                        href="/invoices?status=overdue"
                        action={aiAction('overdue_invoice', overdueInvoices.count)}
                        icon={DocumentTextIcon}
                        label={t('row_overdue_invoices_group', { count: overdueInvoices.count })}
                        detail={
                          overdueInvoices.unconverted_count > 0
                            ? t('row_overdue_invoices_detail_fx', {
                                date: formatDate(overdueInvoices.oldest_due_date),
                                count: overdueInvoices.unconverted_count,
                              })
                            : t('row_overdue_invoices_detail', { date: formatDate(overdueInvoices.oldest_due_date) })
                        }
                        hint={t('row_overdue_invoices_hint')}
                        badge={
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatCurrency(overdueInvoices.remaining_sek)}
                          </span>
                        }
                      />
                    )}
                    {counts.agreement_payment_missed > 0 && (
                      <WorklistRow
                        href="/arkiv/avtal"
                        icon={CalendarDaysIcon}
                        label={t('row_agreement_payment_missed')}
                        hint={t('row_agreement_payment_missed_detail')}
                        count={counts.agreement_payment_missed}
                      />
                    )}
                    {counts.reconciliation_due > 0 && (
                      <WorklistRow
                        href="/reconciliation"
                        action={aiAction('reconciliation_due', counts.reconciliation_due)}
                        icon={ScaleIcon}
                        label={t('row_reconciliation_due')}
                        hint={t('row_reconciliation_due_detail')}
                        count={counts.reconciliation_due}
                      />
                    )}
                    {calmSwitches.map(switchRow)}
                    {verificationCalm && verificationRow(verificationCalm)}
                    {expiringBankConnections.length > 0 && (
                      <WorklistRow
                        href="/settings/banking"
                        icon={BuildingLibraryIcon}
                        label={t('bank_consent_expiring')}
                        detail={
                          expiringBankConnections[0].days_left === 1
                            ? t('bank_consent_detail_one', {
                                bank: expiringBankConnections[0].bank_name,
                                days: expiringBankConnections[0].days_left,
                              })
                            : t('bank_consent_detail_other', {
                                bank: expiringBankConnections[0].bank_name,
                                days: expiringBankConnections[0].days_left,
                              })
                        }
                        count={expiringBankConnections.length}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
      </div>
      {(showKopplingar || firstTaskClient) && (
        <KopplingarChips
          aiConnection={aiConnection}
          firstTask={firstTaskClient}
          firstTaskOnly={!showKopplingar}
          hasBank={hasActiveBankConnection}
          hasSkatteverket={hasSkatteverketConnection}
          skvOmbudEnabled={skvOmbudEnabled}
        />
      )}
      {collectionsRun.run && collectionsRunOpen && (
        <HandoverBatchDialog
          key={collectionsRun.run.id}
          operationId={collectionsRun.run.id}
          open={collectionsRunOpen}
          onOpenChange={setCollectionsRunOpen}
          onCommitted={() => {
            void collectionsRun.reload()
            void refetchCounts()
          }}
        />
      )}
      {reviewingReminderBatchId && (
        <ReminderBatchDialog
          key={reviewingReminderBatchId}
          operationId={reviewingReminderBatchId}
          open
          onOpenChange={(open) => {
            if (!open) setReviewingReminderBatchId(null)
          }}
          onCommitted={() => {
            void reminderBatch.reload()
            void refetchCounts()
          }}
        />
      )}
      {allocating && (
        <MatchAllocationDialog
          open
          onOpenChange={(open) => {
            if (!open) setAllocating(null)
          }}
          transaction={allocatingTransaction}
          initialAllocations={allocating.allocations ?? null}
          onSuccess={() => {
            // Booked: the row is done. The counts catch up from the server.
            const bookedId = allocating.transaction_id
            setInvoiceSetRows((prev) => prev.filter((row) => row.transaction_id !== bookedId))
            setCounts((prev) => ({ ...prev, suggested_match: Math.max(0, prev.suggested_match - 1) }))
            void refetchCounts()
          }}
        />
      )}
      {reviewingPayeeId && (
        <PayeeChangeDialog
          supplierInvoiceId={reviewingPayeeId}
          onOpenChange={(open) => {
            if (!open) setReviewingPayeeId(null)
          }}
          onDecided={() => {
            // Decided either way: the row is done (a rejection keeps the
            // payment held and says so on the invoice).
            const decidedId = reviewingPayeeId
            setPayeeChanges((prev) => prev.filter((row) => row.supplier_invoice_id !== decidedId))
            void refetchCounts()
          }}
        />
      )}
    </section>
  )
}
