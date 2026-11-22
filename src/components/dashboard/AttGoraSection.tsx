'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { usePublishNeedCount } from './need-count'
import { countThings } from './need-model'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { INKORG_FOCUS_FIRST, INKORG_FOCUS_QUERY, INKORG_HREF, LEGACY_INBOX_HREF } from '@/lib/inkorg/flag'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ViewerLock, useViewerLock } from '@/components/ui/viewer-lock'
import { Dialog, DialogConsequence, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { Skeleton, LateReveal } from '@/components/ui/skeleton'
import { GuidedSteps, HemCalm, NeedList, type HemView, type LeadAction, type NeedRow } from './att-gora-views'
import { countRowSpecs } from './need-rows'
import { isAwaitingAttestInList } from '@/lib/supplier-invoices/list-tabs'
import type { SupplierInvoiceRow } from './StepItems'
import { formatCurrency, formatDate } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { useFormat } from '@/lib/hooks/use-format'
import { switchDeepLink } from '@/lib/bank-feed/switch-link'
import { useCapability, useCompany } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { AiTaskCategory } from '@/lib/worklist/ai-task'
import type { DocumentToSignDue, PaymentFailedDue, PaymentsVerificationDue, SuggestedMatch, SupplierPayeeChangeDue } from '@/lib/worklist/types'
import type { AllocationTransaction } from '@/components/transactions/MatchAllocationDialog'
import { PAYMENTS_PAGE_PATH } from '@/lib/payments/orders/page-path'
import { failedPaymentReasonText, type BankPaymentsTranslator } from '@/lib/payments/orders/failed-payment-reason'
import type { MissingUnderlagSample } from '@/lib/worklist/missing-underlag'
import { NO_AI_CONNECTION, type AiClient, type AiConnection } from '@/lib/onboarding/ai-clients'
import { attGoraEmptyState } from '@/lib/onboarding/checklist'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { AiTaskAction } from './AiTaskAction'
import { KopplingarChips } from './KopplingarChips'
import { SuggestionCards } from './SuggestionCards'
import { GrantPostings } from './GrantPostings'
import type { GrantReview } from '@/lib/grants/types'
import type { OpenSuggestion } from '@/lib/suggestions/types'
import { BATCH_REVIEW_HREF, batchRowKey } from '@/lib/collections/batch-dialog'
import { usePendingCollectionsRun } from '@/components/collections/collections-run-client'
import { capitalizeFirst } from '@/components/collections/collections-client'
import { REMINDER_BATCH_REVIEW_HREF } from '@/lib/reminders/batch-dialog'
import { usePendingReminderBatch } from '@/components/reminders/reminder-batch-client'
import {
  ArrowsRightLeftIcon,
  BanknotesIcon,
  BellAlertIcon,
  LightBulbIcon,
  BuildingLibraryIcon,
  CalendarDaysIcon,
  CheckBadgeIcon,
  DocumentMagnifyingGlassIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  InboxIcon,
  LinkIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  QuestionMarkCircleIcon,
  ScaleIcon,
  ShieldCheckIcon,
  ShieldExclamationIcon,
} from '@/components/icons'
import type {
  AttestedToPayDue,
  BankSwitchDue,
  ExpensePayoutDue,
  PaymentsToSignDue,
  SkattekontoPaymentDue,
  SupplierInvoiceAttestDue,
  WorklistCounts,
} from '@/lib/worklist/types'

// Loaded when a several-invoice row's "Matcha" is pressed, not with Hem.
const MatchAllocationDialog = dynamic(() => import('@/components/transactions/MatchAllocationDialog'))
// Loaded when they are first shown, not with the page: the three dialogs open
// on a click, and the step contents belong to the Börja view (?vy=borja).
const HandoverBatchDialog = dynamic(() => import('@/components/collections/HandoverBatchDialog').then((m) => m.HandoverBatchDialog))
const ReminderBatchDialog = dynamic(() => import('@/components/reminders/ReminderBatchDialog').then((m) => m.ReminderBatchDialog))
const PayeeChangeDialog = dynamic(() => import('@/components/payments/PayeeChangeDialog').then((m) => m.PayeeChangeDialog))
const StepItems = dynamic(() => import('./StepItems').then((m) => m.StepItems))
const DocumentViewerPane = dynamic(() => import('@/components/bookkeeping/DocumentViewerPane'))

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

/** How many of the company's invoices to attest Börja walks one by one; the rest stay behind the count row. */
const COMPANY_ATTEST_STEPS = 20

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
   * Supplier invoices to pay (lib/worklist attested_to_pay): one Betala row,
   * "Betala N leverantörsfakturor", the invoices the Att betala tab lists.
   */
  attestedToPay?: AttestedToPayDue | null
  /**
   * Bank payments that wait for a person's approval or BankID signature
   * (lib/worklist payments_to_sign): one Betala row, "Signera N betalningar",
   * opening Betalningar, where they are approved and signed.
   */
  paymentsToSign?: PaymentsToSignDue | null
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
  /** How many questions wait for the company's people (lib/questions): one row that opens the list. */
  openQuestions?: number
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
   * True once the checklist is closed while nothing is booked and no bank row
   * can arrive (no active connection, no row ever imported). The all-clear
   * state then says how the first rows get here instead of "all done"
   * (lib/onboarding/checklist attGoraEmptyState).
   */
  noBankFeed?: boolean
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
  /** Appointed, and Skatteverket has not registered the grant yet (KopplingarChips). */
  skvOmbudWaiting?: boolean
  /**
   * Whether to render the kopplingar row under the list. Off while the
   * getting-started checklist is open: it carries the bank and Skatteverket
   * steps itself, and the row would repeat them.
   */
  showKopplingar?: boolean
  /** Which face of the rows to draw: Hem (the summary), Behöver dig (the list), Börja (one at a time). */
  view?: HemView
  /** Börja: the step to open on. */
  initialStep?: string | null
  /** Today in Stockholm (yyyy-MM-dd): what "brådskar" and "Först" are read against. */
  todayIso: string
  /** Hem: Kom igång, under the headline. */
  afterHeadline?: ReactNode
  /** Hem: the glance line under the headline. */
  facts?: ReactNode
  /** The Fortsätt pane (drafts in progress). */
  resume?: ReactNode
}

/**
 * The underlag of an attest step: the invoice file itself, never a redrawn
 * copy, and the lines as they are registered (account and amount). Read from
 * the same route the invoice page reads.
 */
function SupplierInvoiceUnderlag({ invoiceId }: { invoiceId: string }) {
  const tHem = useTranslations('hem')
  const tCommon = useTranslations('common')
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ready'; documentId: string | null; items: Array<{ id: string; description: string; account_number: string | null; line_total: number }>; currency: string }
  >({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    fetch(`/api/supplier-invoices/${invoiceId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const json = await res.json()
        if (!live) return
        const items = [...((json.data?.items ?? []) as Array<{ id: string; description: string; account_number: string | null; line_total: number; sort_order?: number }>)]
        items.sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0))
        setState({ status: 'ready', documentId: json.data?.document_id ?? null, items, currency: json.data?.currency ?? 'SEK' })
      })
      .catch(() => {
        if (live) setState({ status: 'error' })
      })
    return () => {
      live = false
    }
  }, [invoiceId, attempt])

  if (state.status === 'loading') {
    return (
      <LateReveal>
        <Skeleton className="h-64 w-full rounded-lg" />
      </LateReveal>
    )
  }
  if (state.status === 'error') {
    return (
      <p className="text-[13px] text-muted-foreground">
        {tHem('step_underlag_failed')}{' '}
        <button
          type="button"
          className="text-foreground underline underline-offset-[3px]"
          onClick={() => {
            setState({ status: 'loading' })
            setAttempt((n) => n + 1)
          }}
        >
          {tCommon('retry')}
        </button>
      </p>
    )
  }
  return (
    <div className="space-y-3">
      {state.documentId ? (
        <DocumentViewerPane documentId={state.documentId} className="h-[420px] overflow-hidden rounded-lg bg-control shadow-raised" />
      ) : (
        <p className="rounded-lg bg-secondary/35 px-3 py-6 text-center text-[13px] text-muted-foreground">{tHem('step_underlag_missing')}</p>
      )}
      {state.items.length > 0 && (
        <div className="border-t-hairline text-[13px]">
          {state.items.map((item) => (
            <div key={item.id} className="flex min-h-9 items-center gap-4 border-b-hairline py-2">
              <span className="min-w-0 flex-1 truncate" data-ph-mask="">
                {item.account_number && <span className="font-mono text-muted-foreground">{item.account_number} </span>}
                {item.description}
              </span>
              <span className="shrink-0 tabular-nums">{formatCurrency(item.line_total, state.currency)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function AttGoraSection({
  worklist,
  expensePayouts = [],
  attestsDue = [],
  documentsToSign = [],
  skattekontoPayment = null,
  attestedToPay = null,
  paymentsToSign = null,
  bankSwitches = [],
  paymentsVerification = null,
  supplierPayeeChanges = [],
  paymentsFailed = [],
  invoiceSets = [],
  suggestions = [],
  openQuestions = 0,
  grantReview = null,
  expiringBankConnections = [],
  emptyLedger = false,
  noBankFeed = false,
  hasActiveBankConnection = true,
  aiConnection = NO_AI_CONNECTION,
  firstTaskClient = null,
  missingUnderlag,
  hasSkatteverketConnection = false,
  skvOmbudEnabled = false,
  skvOmbudWaiting = false,
  showKopplingar = false,
  view = 'hem',
  initialStep = null,
  todayIso,
  afterHeadline,
  facts,
  resume,
}: AttGoraSectionProps) {
  const tHem = useTranslations('hem')
  const tInvoice = useTranslations('supplier_invoice_detail')
  const tAttestState = useTranslations('supplier_invoice_attest')
  const tCommon = useTranslations('common')
  const { toast } = useToast()
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
  const { canWrite } = useViewerLock()

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
  // The attest rows, and the one being attested from its step (the confirm dialog).
  const [attestRows, setAttestRows] = useState(attestsDue)
  // Börja walks the company's invoices to attest one at a time too, each with
  // its file: read from the route the Registrerade tab reads, by its rule.
  // Null until read (and on Hem and in the list, where the count row stands).
  const [companyAttest, setCompanyAttest] = useState<SupplierInvoiceAttestDue[] | null>(null)
  const wantsCompanyAttest = view === 'borja' && worklist.counts.supplier_invoice_approval > 0
  useEffect(() => {
    if (!wantsCompanyAttest) return
    let live = true
    // Only what is not settled: an invoice to attest is never paid, and
    // the whole register took seconds for a company with years of them.
    fetch('/api/supplier-invoices?status=unsettled')
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const data = ((await res.json()).data ?? []) as SupplierInvoiceRow[]
        if (!live) return
        setCompanyAttest(
          data
            .filter(isAwaitingAttestInList)
            .filter((inv) => inv.due_date && inv.total != null)
            .sort((x, y) => (x.due_date as string).localeCompare(y.due_date as string))
            .slice(0, COMPANY_ATTEST_STEPS)
            .map((inv) => ({
              supplier_invoice_id: inv.id,
              supplier_name: inv.supplier?.name ?? null,
              supplier_invoice_number: inv.supplier_invoice_number ?? null,
              arrival_number: inv.arrival_number ?? 0,
              total: inv.total as number,
              currency: inv.currency ?? 'SEK',
              due_date: inv.due_date as string,
            })),
        )
      })
      .catch(() => {
        // The count row stays and opens the list: nothing is lost.
      })
    return () => {
      live = false
    }
  }, [wantsCompanyAttest])
  const [attesting, setAttesting] = useState<SupplierInvoiceAttestDue | null>(null)
  const [attestBusy, setAttestBusy] = useState(false)
  const [attestError, setAttestError] = useState<string | null>(null)
  // Börja: the step on screen. undefined until the rows exist.
  const [stepKey, setStepKey] = useState<string | null | undefined>(initialStep ?? undefined)
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
  // A count that could not be read answered zero: never "Allt är klart" then.
  const [countsIncomplete, setCountsIncomplete] = useState(worklist.incomplete === true)
  if (worklist !== renderedWorklist) {
    setRenderedWorklist(worklist)
    setCountsIncomplete(worklist.incomplete === true)
    setCounts(worklist.counts)
    setOverdueInvoices(worklist.overdueInvoices ?? null)
    setAttestRows(attestsDue)
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
        setOverdueInvoices(json.data.overdueInvoices ?? null)
        setCountsIncomplete(json.data.incomplete === true)
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

  // The row's AI action, once a client is connected: today only
  // Kvittojakten on "Verifikat utan underlag" (AiTaskAction renders nothing
  // for the other categories).
  const aiActionFor = (category: AiTaskCategory, count: number) =>
    category === 'verifikat_missing_document' ? <AiTaskAction clients={aiConnection.clients} task={{ category, count }} /> : undefined

  const emptyState = attGoraEmptyState({ emptyLedger, noBankFeed })
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  // Shown while anything waits for a look, or while the rules are paused (so
  // the switch to turn them back on stays in reach).
  const grantRows = !!grantReview && (grantReview.postings.length > 0 || grantReview.paused)

  // Where the biggest missing underlag actually have to be fetched from, in
  // one line, derived from the ledger rather than reported back by an agent.
  // Silent when the answer is "look in your mail".
  const topMissingUnderlag = missingUnderlag?.top
  const missingUnderlagDetail =
    topMissingUnderlag && topMissingUnderlag.kind !== 'mail'
      ? t(`missing_underlag_next_${topMissingUnderlag.kind}`, { count: topMissingUnderlag.count })
      : undefined

  // The attest of a step: the same call the invoice page's Attestera makes,
  // behind a confirmation that says what it does (convention 10).
  async function attest(item: SupplierInvoiceAttestDue) {
    setAttestBusy(true)
    setAttestError(null)
    try {
      const res = await fetch(`/api/supplier-invoices/${item.supplier_invoice_id}/approve`, { method: 'POST' })
      const result = await res.json().catch(() => ({}))
      if (!res.ok) {
        setAttestError(getErrorMessage(result, { context: 'supplier_invoice' }))
        return
      }
      const remaining = (result?.data?.attest?.remaining ?? []) as unknown[]
      if (result?.data?.attest?.approved === false && remaining.length > 0) {
        toast({ title: tAttestState('approved_waiting', { count: remaining.length }) })
      } else {
        toast({ title: tInvoice('approved_title'), description: tInvoice('approved_description') })
      }
      setAttestRows((prev) => prev.filter((row) => row.supplier_invoice_id !== item.supplier_invoice_id))
      setCompanyAttest((prev) => prev?.filter((row) => row.supplier_invoice_id !== item.supplier_invoice_id) ?? prev)
      setCounts((prev) => ({ ...prev, supplier_invoice_approval: Math.max(0, prev.supplier_invoice_approval - 1) }))
      setAttesting(null)
      void refetchCounts()
      router.refresh()
    } catch {
      setAttestError(tInvoice('approve_failed_title'))
    } finally {
      setAttestBusy(false)
    }
  }

  // ---- The rows. Every row Att göra has carried is built here once, with the
  // group it belongs to (what the person does), its name, its date and its
  // amount from the data. Hem, Behöver dig and Börja all draw from this list.
  const rows: NeedRow[] = []
  /** Adds a row; one that is not a named thing (a count, a state) is named by its label. */
  const add = (row: Omit<NeedRow, 'name'> & { name?: string }) => rows.push({ ...row, name: row.name ?? row.label })
  const fact = (key: string, value: string | null | undefined) => (value ? [{ label: tHem(`fact_${key}`), value }] : [])
  // Attestera: the person's own attest rows, and in Börja the rest of the
  // company's invoices to attest, one step each.
  const personAttestIds = new Set(attestRows.map((row) => row.supplier_invoice_id))
  const attestSteps = [...attestRows, ...(companyAttest ?? []).filter((row) => !personAttestIds.has(row.supplier_invoice_id))]
  // The rows that are a count and a place to go (need-rows.ts decides which
  // exist, in which group and how much each counts); the words are added here.
  const specs = new Map(
    countRowSpecs({
      counts,
      hasAi,
      inboxHref: worklist.inboxHref ?? LEGACY_INBOX_HREF,
      invoiceSetRows: invoiceSetRows.length,
      personAttestRows: attestSteps.length,
      openQuestions,
    }).map((spec) => [spec.key, spec]),
  )
  // A step that is many things names them: its heading says how many of what
  // ("7 underlag att hantera"), its primary the action, the object and the
  // count ("Granska 7 underlag"), both templates filled from the count.
  const stepWords = (key: string, count: number, goHref?: string): Pick<NeedRow, 'stepTitle' | 'stepGo'> => {
    const id = key.replace(/-/g, '_')
    return { stepTitle: tHem(`step_noun_${id}`, { count }), stepGo: { label: tHem(`step_act_${id}`, { count }), href: goHref } }
  }
  const specRow = (key: string, icon: NeedRow['icon'], more: Partial<NeedRow> = {}) => {
    const spec = specs.get(key)
    if (!spec) return
    add({
      key,
      group: spec.group,
      icon,
      label: t(spec.labelKey),
      hint: spec.hintKey ? t(spec.hintKey) : undefined,
      href: spec.href,
      count: spec.count,
      things: spec.things,
      // The documents have a one-at-a-time view of their own: the primary opens it at the first one.
      ...stepWords(key, spec.count, key === 'inbox-documents' && spec.href === INKORG_HREF ? `${INKORG_HREF}?${INKORG_FOCUS_QUERY}=${INKORG_FOCUS_FIRST}` : undefined),
      stepBody: spec.items ? <StepItems kind={spec.items} total={spec.count} href={spec.href} /> : undefined,
      stepEarliestLabel: spec.earliest ? tHem(spec.earliest === 'due' ? 'fact_due' : 'fact_oldest') : undefined,
      extra: spec.category === 'verifikat_missing_document' ? aiActionFor(spec.category, spec.count) : undefined,
      ...more,
    })
  }
  const countRow = (show: boolean, row: Parameters<typeof add>[0]) => {
    if (show) add(row)
  }

  for (const a of attestSteps) {
    const supplier = a.supplier_name ?? tAttest('supplier_fallback')
    rows.push({
      key: `attest-${a.supplier_invoice_id}`,
      group: 'attest',
      icon: CheckBadgeIcon,
      name: supplier,
      label: tAttest('row_label', { supplier, amount: formatCurrency(a.total, a.currency) }),
      // The step shows the amount beside its heading: the heading is who and which invoice.
      stepTitle: tHem('step_title_invoice', { supplier, invoice: a.supplier_invoice_number ?? `#${a.arrival_number}` }),
      detail: tAttest('row_detail', { date: formatDate(a.due_date) }),
      href: `/supplier-invoices/${a.supplier_invoice_id}`,
      due: a.due_date,
      amount: { value: a.total, currency: a.currency },
      facts: [
        ...fact('supplier', supplier),
        ...fact('invoice', a.supplier_invoice_number ?? `#${a.arrival_number}`),
        ...fact('due', formatDate(a.due_date)),
      ],
      stepBody: <SupplierInvoiceUnderlag invoiceId={a.supplier_invoice_id} />,
      stepAct: { label: tInvoice('approve'), run: () => { setAttestError(null); setAttesting(a) } },
    })
  }
  specRow('supplier-approval', CheckBadgeIcon)

  // Betala
  for (const item of paymentsFailed) {
    const reason = failedPaymentReasonText(tBankPayments as unknown as BankPaymentsTranslator, item.status, item.reason_code)
    const invoice = item.supplier_invoice_number?.trim() || (item.arrival_number != null ? `#${item.arrival_number}` : null)
    rows.push({
      key: `payment-failed-${item.supplier_invoice_id}`,
      group: 'pay',
      urgent: true,
      icon: ExclamationTriangleIcon,
      name: item.payee_name,
      label: t('row_payment_failed', { payee: item.payee_name }),
      hint: t('row_payment_failed_hint'),
      detail: invoice ? t('row_payment_failed_detail', { invoice, reason }) : reason,
      href: `/supplier-invoices/${item.supplier_invoice_id}`,
      due: item.due_date,
      amount: { value: item.amount, currency: item.currency },
      facts: [...fact('payee', item.payee_name), ...fact('invoice', invoice), ...fact('reason', reason)],
    })
  }
  if (attestedToPay) {
    add({
      key: 'attested-to-pay',
      group: 'pay',
      icon: BanknotesIcon,
      label: t('row_supplier_invoices_to_pay', { count: attestedToPay.count }),
      detail:
        attestedToPay.overdue > 0
          ? t('row_attested_to_pay_detail_overdue', { overdue: attestedToPay.overdue, date: formatDate(attestedToPay.next_due) })
          : t('row_attested_to_pay_detail', { date: formatDate(attestedToPay.next_due) }),
      href: '/supplier-invoices?tab=to_pay',
      due: attestedToPay.next_due,
      things: attestedToPay.count,
      urgentThings: attestedToPay.overdue > 0 ? attestedToPay.overdue : attestedToPay.count,
      stepBody: <StepItems kind="to_pay" total={attestedToPay.count} href="/supplier-invoices?tab=to_pay" />,
      // The row's own label is the action, the object and the count.
      stepGo: { label: t('row_supplier_invoices_to_pay', { count: attestedToPay.count }) },
      facts: [...fact('due', formatDate(attestedToPay.next_due))],
    })
  }
  // Prepared and not signed (by a person, the API or an agent), or back from
  // a BankID that ended unsigned: nothing reaches the bank until someone signs.
  if (paymentsToSign) {
    const label = t('row_payments_to_sign', { count: paymentsToSign.count })
    const paymentDay = formatDate(paymentsToSign.next_date)
    add({
      key: 'payments-to-sign',
      group: 'pay',
      icon: PencilSquareIcon,
      label,
      hint: t('row_payments_to_sign_hint', { count: paymentsToSign.count }),
      detail:
        paymentsToSign.to_approve > 0
          ? t('row_payments_to_sign_detail_approve', { count: paymentsToSign.to_approve, date: paymentDay })
          : t('row_payments_to_sign_detail', { date: paymentDay }),
      href: PAYMENTS_PAGE_PATH,
      due: paymentsToSign.next_date,
      things: paymentsToSign.count,
      amount: paymentsToSign.amount !== null ? { value: paymentsToSign.amount, currency: paymentsToSign.currency } : undefined,
      // The row's own label is the action, the object and the count.
      stepGo: { label },
      facts: [
        ...fact('to_approve', paymentsToSign.to_approve > 0 ? String(paymentsToSign.to_approve) : null),
        ...fact('payment_day', paymentDay),
      ],
    })
  }
  if (skattekontoPayment) {
    add({
      key: 'skattekonto-payment',
      group: 'pay',
      icon: BuildingLibraryIcon,
      label: t('row_skattekonto_payment'),
      detail: skattekontoPayment.ocr
        ? t('row_skattekonto_payment_detail', { bankgiro: skattekontoPayment.bankgiro, ocr: skattekontoPayment.ocr, date: formatDate(skattekontoPayment.due) })
        : t('row_skattekonto_payment_detail_no_ocr', { bankgiro: skattekontoPayment.bankgiro, date: formatDate(skattekontoPayment.due) }),
      href: '/skattekonto?betala=1',
      due: skattekontoPayment.due,
      amount: { value: skattekontoPayment.amount },
      facts: [
        ...fact('bankgiro', skattekontoPayment.bankgiro),
        ...fact('ocr', skattekontoPayment.ocr),
        ...fact('due', formatDate(skattekontoPayment.due)),
      ],
    })
  }
  for (const p of expensePayouts) {
    rows.push({
      key: `expense-${p.key}`,
      group: 'pay',
      icon: BanknotesIcon,
      name: p.claimant_name,
      label: t('row_expense_payout', { name: p.claimant_name }),
      detail:
        p.claim_count === 1
          ? t('row_expense_payout_detail_one', { date: formatDate(p.oldest_expense_date) })
          : t('row_expense_payout_detail_other', { count: p.claim_count, date: formatDate(p.oldest_expense_date) }),
      href: '/expenses',
      amount: { value: p.total_sek },
      facts: [...fact('person', p.claimant_name), ...fact('oldest', formatDate(p.oldest_expense_date))],
    })
  }

  // Signera
  for (const d of documentsToSign) {
    rows.push({
      key: `sign-${d.signer_id}`,
      group: 'sign',
      icon: PencilSquareIcon,
      name: d.title,
      label: t('row_document_to_sign', { title: d.title }),
      detail: d.role_label
        ? t('row_document_to_sign_detail_role', { role: d.role_label, date: formatDateLong(d.expires_at) })
        : t('row_document_to_sign_detail', { date: formatDateLong(d.expires_at) }),
      href: `/signering/${d.signer_id}`,
      due: d.expires_at,
      facts: [...fact('role', d.role_label), ...fact('open_until', formatDateLong(d.expires_at))],
    })
  }

  // Bokför
  specRow('book-transactions', ArrowsRightLeftIcon)
  specRow('book-skattekonto', BuildingLibraryIcon)
  // One row per bank row that settles several invoices of one counterparty
  // (PH 192): the label opens the row in Transaktioner, "Matcha" the batch
  // allocation with the invoices picked, confirmed there before anything is
  // booked.
  for (const item of invoiceSetRows) {
    const count = item.allocations?.length ?? 0
    const receipt = item.kind === 'invoice'
    const label = item.counterparty_name
      ? t(receipt ? 'row_invoice_set_receipt' : 'row_invoice_set_payment', { count, name: item.counterparty_name })
      : t(receipt ? 'row_invoice_set_receipt_unnamed' : 'row_invoice_set_payment_unnamed', { count })
    rows.push({
      key: `invoice-set-${item.transaction_id}`,
      group: 'book',
      icon: LinkIcon,
      name: item.counterparty_name ?? label,
      label,
      hint: t('row_invoice_set_hint'),
      detail: item.candidate_number
        ? t('row_invoice_set_detail', { date: formatDate(item.transaction_date), invoices: item.candidate_number })
        : formatDate(item.transaction_date),
      href: `/transactions?highlight=${item.transaction_id}`,
      // One of the transactions to book: counted there.
      things: 0,
      amount: { value: Math.abs(item.transaction_amount), currency: item.transaction_currency },
      act: { label: t('invoice_set_match'), run: () => setAllocating(item) },
      facts: [...fact('date', formatDate(item.transaction_date)), ...fact('invoice', item.candidate_number)],
      // The bank row itself, as the bank wrote it.
      stepBody: (
        <div className="flex min-h-11 items-center gap-3 border-y-hairline py-2 text-[13px]">
          <span className="min-w-0 flex-1 truncate" data-ph-mask="">
            <span className="date-figures">{formatDate(item.transaction_date)}</span> · {item.transaction_description}
          </span>
          <span className="shrink-0 tabular-nums">{formatCurrency(item.transaction_amount, item.transaction_currency)}</span>
        </div>
      ),
    })
  }
  specRow('suggested-matches', LinkIcon)
  specRow('inbox-documents', InboxIcon)
  specRow('collection-settlements', BanknotesIcon)
  specRow('collected-payments', BanknotesIcon)

  // Bestäm
  // One row per supplier invoice whose bank details wait for a decision: the
  // label opens the invoice, "Granska" the decision itself. A changed account
  // is the classic invoice fraud, so the rows are urgent.
  for (const item of payeeChanges) {
    const invoice = item.supplier_invoice_number ?? `#${item.arrival_number ?? ''}`
    rows.push({
      key: `payee-${item.supplier_invoice_id}`,
      group: 'decide',
      urgent: true,
      icon: ShieldExclamationIcon,
      name: item.supplier_name,
      label: t('row_supplier_payee_change', { supplier: item.supplier_name }),
      detail: item.old_payee
        ? t('row_supplier_payee_change_detail', { invoice, payee: item.new_payee, card: item.old_payee })
        : t('row_supplier_payee_new_detail', { invoice, payee: item.new_payee }),
      href: `/supplier-invoices/${item.supplier_invoice_id}`,
      due: item.due_date,
      act: { label: t('supplier_payee_review'), run: () => setReviewingPayeeId(item.supplier_invoice_id) },
      facts: [
        ...fact('supplier', item.supplier_name),
        ...fact('invoice', invoice),
        ...fact('new_account', item.new_payee),
        ...fact('card_account', item.old_payee),
      ],
    })
  }
  specRow('collection-decision', ScaleIcon)
  specRow('company-questions', QuestionMarkCircleIcon)
  countRow(counts.collection_batch_ready > 0, {
    key: 'collection-batch',
    group: 'decide',
    icon: ScaleIcon,
    label: capitalizeFirst(tCollections(batchRowKey(collectionsRun.run?.items ?? []), { count: counts.collection_batch_ready })),
    hint: t('row_collection_batch_cta'),
    href: BATCH_REVIEW_HREF,
    ...stepWords('collection-batch', counts.collection_batch_ready),
    // The run's own items, which the row already holds: no read.
    stepBody: collectionsRun.run ? (
      <StepItems
        kind="given"
        total={collectionsRun.run.items.length}
        href={BATCH_REVIEW_HREF}
        items={collectionsRun.run.items.map((item) => ({
          id: `${item.kind}-${item.invoice_id}`,
          name: [item.customer_name, item.invoice_number].filter(Boolean).join(' · '),
          date: item.due_date,
          amount: item.remaining_amount,
          currency: null,
          href: `/invoices/${item.invoice_id}`,
        }))}
      />
    ) : undefined,
    onSelect: collectionsRun.run ? () => setCollectionsRunOpen(true) : undefined,
  })
  countRow(counts.reminder_batch_ready > 0, {
    key: 'reminder-batch',
    group: 'decide',
    icon: BellAlertIcon,
    label: tReminders('batch_row', { count: counts.reminder_batch_ready }),
    hint: t('row_reminder_batch_cta'),
    href: REMINDER_BATCH_REVIEW_HREF,
    ...stepWords('reminder-batch', counts.reminder_batch_ready),
    stepBody: reminderBatch.batch ? (
      <StepItems
        kind="given"
        total={reminderBatch.batch.items.length}
        href={REMINDER_BATCH_REVIEW_HREF}
        items={reminderBatch.batch.items.map((item) => ({
          id: item.invoice_id,
          name: [item.customer_name, item.invoice_number].filter(Boolean).join(' · '),
          date: item.due_date,
          amount: item.remaining_amount,
          currency: item.currency,
          href: `/invoices/${item.invoice_id}`,
        }))}
      />
    ) : undefined,
    onSelect: reminderBatchId ? () => setReviewingReminderBatchId(reminderBatchId) : undefined,
  })
  // The Förslag cards: each carries its own Ja, Inte nu and Visa aldrig.
  for (const s of openSuggestions) {
    add({
      key: `suggestion-${s.suggestion_id}`,
      group: 'decide',
      icon: LightBulbIcon,
      label: s.title,
      detail: s.reason ?? undefined,
      href: '/?vy=behover#decide',
      embed: (
        <ViewerLock>
          <SuggestionCards
            suggestions={[s]}
            onResolved={(answered) => {
              setOpenSuggestions((prev) => prev.filter((x) => x.suggestion_id !== answered.suggestion_id))
              void refetchCounts()
            }}
          />
        </ViewerLock>
      ),
    })
  }

  // Granska
  specRow('document-relevance', DocumentMagnifyingGlassIcon)
  specRow('document-unclassified', DocumentMagnifyingGlassIcon)
  specRow('document-field-review', DocumentMagnifyingGlassIcon)
  specRow('arkiv-finding', DocumentMagnifyingGlassIcon)
  specRow('peppol-failed', PaperAirplaneIcon)
  specRow('collection-attention', ScaleIcon)
  if (grantRows && grantReview) {
    add({
      key: 'grant-postings',
      group: 'review',
      icon: ShieldCheckIcon,
      label: t('band_grant_postings'),
      href: '/?vy=behover#review',
      count: grantReview.postings.length,
      embed: (
        <div>
          <p className="px-1 pb-1 pt-3 text-xs font-medium text-muted-foreground">{t('band_grant_postings')}</p>
          {/* Keyed by what the server sent, so a refreshed render resets the list. */}
          <ViewerLock>
            <GrantPostings
              key={`${grantReview.paused ? 'p' : 'a'}:${grantReview.postings.map((p) => p.use_id).join(',')}`}
              review={grantReview}
              onChanged={() => router.refresh()}
            />
          </ViewerLock>
        </div>
      ),
    })
  }

  // Ladda upp
  specRow('missing-underlag', ExclamationTriangleIcon, {
    detail: missingUnderlagDetail,
  })

  // Bevaka: time-driven.
  specRow('deadlines', CalendarDaysIcon)
  // One row for all of the company's overdue customer invoices
  // (lib/worklist OverdueInvoicesDue): a fact and where to act, landing on
  // Förfallna, the view that lists the same invoices.
  if (overdueInvoices) {
    add({
      key: 'overdue-invoices',
      group: 'watch',
      icon: DocumentTextIcon,
      label: t('row_overdue_invoices_group', { count: overdueInvoices.count }),
      detail:
        overdueInvoices.unconverted_count > 0
          ? t('row_overdue_invoices_detail_fx', { date: formatDate(overdueInvoices.oldest_due_date), count: overdueInvoices.unconverted_count })
          : t('row_overdue_invoices_detail', { date: formatDate(overdueInvoices.oldest_due_date) }),
      hint: t('row_overdue_invoices_hint'),
      href: '/invoices?status=overdue',
      things: overdueInvoices.count,
      stepBody: <StepItems kind="overdue" total={overdueInvoices.count} href="/invoices?status=overdue" />,
      stepGo: { label: tHem('step_act_overdue_invoices', { count: overdueInvoices.count }) },
      amount: { value: overdueInvoices.remaining_sek },
      extra: aiActionFor('overdue_invoice', overdueInvoices.count),
      facts: [...fact('oldest', formatDate(overdueInvoices.oldest_due_date))],
    })
  }
  specRow('agreement-missed', CalendarDaysIcon)
  specRow('reconciliation-due', ScaleIcon)
  // One row per connection to switch: the deep link opens Koppla banken in
  // switch mode for exactly that row. Past the deadline the row says the
  // feed has stopped; inside 14 days a chip counts the days.
  for (const item of bankSwitches) {
    rows.push({
      key: `bank-switch-${item.connection_id}`,
      group: 'watch',
      urgent: item.urgent,
      icon: BuildingLibraryIcon,
      name: item.bank_name,
      label: item.passed
        ? t('row_bank_switch_stopped', { bank: item.bank_name })
        : t('row_bank_switch', { bank: item.bank_name, date: formatDateLong(item.deadline) }),
      hint: t('row_bank_switch_detail'),
      href: switchDeepLink(item.connection_id),
      due: item.deadline,
      badge: item.passed ? (
        <Badge variant="destructive">{t('bank_switch_stopped_badge')}</Badge>
      ) : item.urgent ? (
        <Badge variant="warning">{t('bank_switch_days_left', { days: Math.max(item.days_left, 0) })}</Badge>
      ) : undefined,
      facts: [...fact('bank', item.bank_name)],
    })
  }
  // The payments verification to start or renew: the deep link opens
  // Betalningar, whose header starts the form. Expired (payments refused) is
  // urgent; a chip counts the days while it is expiring.
  if (paymentsVerification) {
    const item = paymentsVerification
    const label =
      item.state === 'not_started'
        ? t('row_payments_verification_start')
        : item.state === 'expired'
          ? t('row_payments_verification_expired')
          : t('row_payments_verification_expiring')
    add({
      key: 'payments-verification',
      group: 'watch',
      urgent: item.state === 'expired',
      icon: ShieldCheckIcon,
      label,
      hint: item.state === 'not_started' ? t('row_payments_verification_start_detail') : t('row_payments_verification_detail'),
      href: PAYMENTS_PAGE_PATH,
      due: item.state === 'expiring' ? item.valid_until : null,
      badge:
        item.state === 'not_started' ? undefined : item.state === 'expired' ? (
          <Badge variant="destructive">{t('payments_verification_expired_badge')}</Badge>
        ) : item.days_left !== null ? (
          <Badge variant="warning">{t('payments_verification_days_left', { days: Math.max(item.days_left, 0) })}</Badge>
        ) : undefined,
    })
  }
  if (expiringBankConnections.length > 0) {
    const first = expiringBankConnections[0]
    add({
      key: 'bank-consent',
      group: 'watch',
      icon: BuildingLibraryIcon,
      label: t('bank_consent_expiring'),
      detail: t(first.days_left === 1 ? 'bank_consent_detail_one' : 'bank_consent_detail_other', { bank: first.bank_name, days: first.days_left }),
      href: '/settings/banking',
      count: expiringBankConnections.length,
      things: expiringBankConnections.length,
      ...stepWords('bank-consent', expiringBankConnections.length),
      stepBody: (
        <StepItems
          kind="given"
          total={expiringBankConnections.length}
          href="/settings/banking"
          items={expiringBankConnections.map((c) => ({
            id: c.id,
            name: t(c.days_left === 1 ? 'bank_consent_detail_one' : 'bank_consent_detail_other', { bank: c.bank_name, days: c.days_left }),
            date: null,
            amount: null,
            currency: null,
            href: '/settings/banking',
          }))}
        />
      ),
    })
  }

  // Börja: open on the asked step, else the first; a step whose row is gone
  // (done in place) hands over to the row now in its position.
  const stepKeys = rows.map((row) => row.key)
  const [lastIndex, setLastIndex] = useState(0)
  let currentStep: string | null = null
  if (view === 'borja' && stepKey !== null) {
    const found = stepKey === undefined ? -1 : stepKeys.indexOf(stepKey)
    const index = found === -1 ? (stepKey === undefined ? 0 : lastIndex) : found
    currentStep = stepKeys[index] ?? null
    if (found !== -1 && found !== lastIndex) setLastIndex(found)
  }
  function goToStep(key: string | null) {
    setStepKey(key)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (key) url.searchParams.set('steg', key)
    else url.searchParams.delete('steg')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
  }

  // What the all-clear state says under the headline: the product's own lines
  // for a new ledger, a company without a bank feed, and all caught up.
  const clearBody: ReactNode =
    emptyState === 'new_ledger' ? (
      t('att_gora_new_body')
    ) : emptyState === 'no_bank_feed' ? (
      // Both ways to a first row to book, in the line itself: this company
      // finished the books act without a bank.
      <span>
        {t.rich(hasBankingExtension ? 'att_gora_no_bank_body' : 'att_gora_no_bank_file_body', {
          connect: (chunks) => (
            <Link href="/import?mode=psd2" className="text-foreground underline underline-offset-[3px]">{chunks}</Link>
          ),
          file: (chunks) => (
            <Link href="/import?mode=bank" className="text-foreground underline underline-offset-[3px]">{chunks}</Link>
          ),
        })}
      </span>
    ) : (
      t('att_gora_empty_body')
    )
  // A company that has not got going (nothing booked, and either the Kom igång
  // steps are still open or no bank row can arrive): an empty list leads with
  // getting started, never with "all done".
  const notStarted = emptyState !== 'all_done'
  // The page's primary while nothing waits and the company has not got
  // going: the way to a first row. With the Kom igång steps open they hold
  // the action on Hem, and the list points back at them. Connecting or
  // importing is a write, so a read-only member is offered neither.
  const lead: LeadAction | null =
    emptyState === 'no_bank_feed' && canWrite
      ? hasBankingExtension
        ? { label: tHem('lead_connect_bank'), href: '/import?mode=psd2' }
        : { label: tHem('lead_import_statement'), href: '/import?mode=bank' }
      : null

  const connections =
    showKopplingar || firstTaskClient ? (
      <KopplingarChips
        aiConnection={aiConnection}
        firstTask={firstTaskClient}
        firstTaskOnly={!showKopplingar}
        hasBank={hasActiveBankConnection}
        hasSkatteverket={hasSkatteverketConnection}
        skvOmbudEnabled={skvOmbudEnabled}
        skvOmbudWaiting={skvOmbudWaiting}
      />
    ) : null

  // The sidebar's Behöver dig row shows the number Hem counts (need-count.ts).
  usePublishNeedCount(company?.id, countThings(rows))

  return (
    <section aria-label={t('att_gora_title')}>
      {view === 'borja' ? (
        <GuidedSteps rows={rows} todayIso={todayIso} stepKey={currentStep} onStep={goToStep} notStarted={notStarted} />
      ) : view === 'behover' ? (
        <NeedList
          rows={rows}
          todayIso={todayIso}
          clearTitle={tHem(notStarted ? 'headline_not_started' : 'headline_clear')}
          // The Kom igång steps are on Hem, not above this list: say where, and lead there.
          clearBody={emptyState === 'new_ledger' ? tHem('new_ledger_list_body') : clearBody}
          notStarted={notStarted}
          lead={emptyState === 'new_ledger' ? { label: tHem('back_home'), href: '/' } : lead}
          resume={resume}
          incomplete={countsIncomplete}
        />
      ) : (
        <HemCalm
          rows={rows}
          todayIso={todayIso}
          pendingCount={counts.pending_operations}
          // Under the headline the Kom igång steps follow at once while they
          // are open, and they are the lead: the line that points up at them
          // is for the list view.
          clearBody={emptyState === 'new_ledger' && afterHeadline ? null : clearBody}
          notStarted={notStarted}
          lead={lead}
          facts={facts}
          afterHeadline={afterHeadline}
          resume={resume}
          connections={connections}
          incomplete={countsIncomplete}
        />
      )}

      {/* The attest of a step, confirmed up front: the same call as the invoice page's Attestera. */}
      <Dialog open={attesting != null} onOpenChange={(open) => { if (!open && !attestBusy) setAttesting(null) }}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{tInvoice('approve')}</DialogTitle>
            <DialogDescription data-ph-mask="">
              {attesting
                ? tAttest('row_label', {
                    supplier: attesting.supplier_name ?? tAttest('supplier_fallback'),
                    amount: formatCurrency(attesting.total, attesting.currency),
                  })
                : ''}
            </DialogDescription>
          </DialogHeader>
          {attestError && <p className="text-[13px] text-destructive" role="alert">{attestError}</p>}
          <DialogFooter>
            <DialogConsequence>{tHem('attest_consequence')}</DialogConsequence>
            <Button variant="ghost" onClick={() => setAttesting(null)} disabled={attestBusy}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={() => attesting && void attest(attesting)} loading={attestBusy}>
              {tInvoice('approve')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
