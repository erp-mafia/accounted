'use client'

import { Fragment, useState, useEffect, useCallback, useRef, type ComponentProps, type ComponentType } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useParams, usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useViewerLock } from '@/components/ui/viewer-lock'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Checkbox } from '@/components/ui/checkbox'
import { DataListEmpty, DataListLoading } from '@/components/ui/data-list'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { LateReveal } from '@/components/ui/skeleton'
import { AttnLine } from '@/components/ui/attn-line'
import { ContextPicker } from '@/components/common/ContextPicker'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { RowSelectCheckbox, HOVER_REVEAL_CLASS, LIST_BLEED_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useBulkSelection } from '@/lib/hooks/use-bulk-selection'
import {
  SlideOver,
  SlideOverContent,
  SlideOverHeader,
  SlideOverBody,
  SlideOverFooter,
} from '@/components/ui/slide-over'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { cn, formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createClient } from '@/lib/supabase/client'
import { subscribeAsUser } from '@/lib/supabase/realtime-subscribe'
import { refreshWorklistBadges } from '@/lib/hooks/use-worklist-badges'
import { collectPages } from '@/lib/lists/collect-pages'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import {
  ArrowsUpDownIcon,
  ChatBubbleLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentCheckIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  SpinnerIcon,
} from '@/components/icons'
import type {
  PendingOperation,
  PendingOperationRejectionCategory,
} from '@/types'
import {
  OperationPreview,
  AccountNamesContext,
  useComplianceWarningText,
} from '@/components/pending-operations/OperationPreview'
import { useAccountNamesSource } from '@/components/pending-operations/use-account-names'
import { ApprovalHoverPreview } from '@/components/pending-operations/ApprovalHoverPreview'
import { SigningStep, signingUrlOf } from '@/components/pending-operations/SigningStep'
import {
  complianceWarningOf,
  operationLabel,
  registerBookedInvoiceBulkLine,
  registerBookedSupplierInvoiceBulkLine,
  rowConsentSentence,
  singleActionWarning,
  REJECTION_CATEGORY_LABELS,
  rejectionCategoryLabel,
} from '@/components/pending-operations/vocabulary'
import { pickSpotCheck, SPOT_CHECK_SIZE, type SpotCheckReason } from '@/components/pending-operations/spot-check'
import {
  ProposalReviewDrawerBody,
  ReviewActionButtons,
  ReviewRisk,
  ReviewWalk,
  ReviewWalkLoading,
  useReviewGate,
  type ReviewPrimary,
} from '@/components/pending-operations/ProposalReview'
import { headlineAmount, isAutoExpired, missingFields, stepAfterLeaving, stepPosition } from '@/components/pending-operations/review-model'
import { ProposalNumber, proposalNumberLabel } from '@/components/pending-operations/ProposalNumber'
import { factLabelText } from '@/components/pending-operations/preview-parts'
import {
  NO_APPROVAL_RESULTS,
  clearFailure,
  failedIds,
  failureKindOf,
  failureOf,
  parseStoredResults,
  recordFailure,
  recordFailures,
  type ApprovalFailure,
  type ApprovalResults,
} from '@/components/pending-operations/approval-results'
import { describeRetrievedSkills } from '@/lib/agent-skills/retrieved-skills'
import { useAttribution, type ActorRef } from '@/lib/attribution/use-attribution'
import type { AttributionOptions } from '@/lib/attribution/format-actor'
import {
  chunkIds,
  sharedAcknowledgmentGroup,
  summarizeSharedAcknowledgment,
  type SharedAcknowledgmentGroup,
} from '@/lib/pending-operations/shared-acknowledgment'
import { oldestStagedFirst } from '@/lib/pending-operations/commit-order'
import { closedByRefusalReason, readApprovalRefusal, type ApprovalRefusal } from '@/lib/pending-operations/approval-refusal'
import { fixableRefusalFor } from '@/lib/pending-operations/fixable-refusals'
import VoucherWarningsDialog from '@/components/bookkeeping/VoucherWarningsDialog'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { registerBookedLedgerOf } from '@/lib/invoices/register-booked-invoice-mode'
import { COLLECTIONS_BATCH_TYPE } from '@/lib/collections/batch'
import { BATCH_REVIEW_QUERY, batchRowKey, runItems, wantsBatchReview } from '@/lib/collections/batch-dialog'
import { capitalizeFirst } from '@/components/collections/collections-client'
import type { ReminderBatchDialog as ReminderBatchDialogType } from '@/components/reminders/ReminderBatchDialog'
import { REMINDER_BATCH_TYPE } from '@/lib/reminders/batch'
import { reminderRunItems, wantsReminderBatchReview } from '@/lib/reminders/batch-dialog'
import { dailyBatchTypeOf, pendingDailyBatchTypeOf, type DailyBatchType } from '@/lib/pending-operations/daily-batches'
import { isHandledElsewhere } from '@/lib/pending-operations/handled-elsewhere'
import DuplicateBookingDialog from '@/components/transactions/DuplicateBookingDialog'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'

// Terse per-type labels used in the bulk confirmation dialog list. Phrased so
// they read naturally under the heading "Genom att bekräfta utförs följande:".
const bulkActionDescriptions: Record<string, (count: number) => string> = {
  create_transaction: (n) =>
    n === 1 ? 'En transaktion skapas.' : `${n} transaktioner skapas.`,
  create_customer: (n) => (n === 1 ? 'En ny kund skapas.' : `${n} nya kunder skapas.`),
  create_invoice: (n) =>
    n === 1 ? 'Ett fakturautkast skapas (skickas inte).' : `${n} fakturautkast skapas (skickas inte).`,
  // Registrations of already-booked invoices (bulkActionKey).
  register_booked_invoice: registerBookedInvoiceBulkLine,
  register_booked_supplier_invoice: registerBookedSupplierInvoiceBulkLine,
  categorize_transaction: (n) =>
    n === 1 ? 'En transaktion kategoriseras och bokförs.' : `${n} transaktioner kategoriseras och bokförs.`,
  match_transaction_invoice: (n) =>
    n === 1 ? 'En transaktion matchas mot en faktura.' : `${n} transaktioner matchas mot fakturor.`,
  attach_document_to_transaction: (n) =>
    n === 1 ? 'Ett dokument bifogas en transaktion.' : `${n} dokument bifogas transaktioner.`,
  uncategorize_transaction: (n) =>
    n === 1 ? 'En kategorisering tas bort.' : `${n} kategoriseringar tas bort.`,
}

/**
 * The grouping key of the bulk dialog and the "all of this type" shortcuts. A
 * registration of an already-booked invoice shares create_invoice's pending
 * type (or, for a supplier invoice, create_supplier_invoice_from_inbox's) but
 * creates no draft and posts nothing (crm#1094), so it gets its own line and
 * its own shortcut instead of being counted with them.
 */
const REGISTER_BOOKED_BULK_KEYS = {
  customer: 'register_booked_invoice',
  supplier: 'register_booked_supplier_invoice',
} as const

// What the person fixes, per refusal code of lib/pending-operations/
// fixable-refusals.ts (the list of codes lives there; the words live here).
// The toast says the refusal's own sentence (it names the numbers) unless
// noteInToast: Skatteverket's "Sessionen har gått ut. Logga in med BankID
// igen." names neither Skatteverket nor where to log in, and the unfinished
// SIE import's registry sentence ends "Starta sedan den här importen igen.",
// where here the way on is approving the same proposal again.
const FIXABLE_REFUSAL_COPY: Record<string, { note: string; link: string; noteInToast?: boolean }> = {
  SKATTEVERKET_NOT_CONNECTED: { note: 'refusal_fix_skatteverket', link: 'refusal_fix_skatteverket_link', noteInToast: true },
  INVOICE_NUMBER_SERIES_BEHIND: { note: 'refusal_fix_invoice_series', link: 'refusal_fix_invoicing_link' },
  INVOICE_SEND_PAYMENT_ACCOUNT_MISSING: { note: 'refusal_fix_payment_details', link: 'refusal_fix_invoicing_link' },
  INVOICE_SEND_VAT_NUMBER_MISSING: { note: 'refusal_fix_vat_number', link: 'refusal_fix_tax_link' },
  SIE_IMPORT_UNFINISHED: { note: 'refusal_fix_sie_import', link: 'refusal_fix_sie_import_link', noteInToast: true },
  CASH_ACCOUNT_DISABLED_PAYEE: { note: 'refusal_fix_disabled_payee', link: 'refusal_fix_bookkeeping_link' },
}

function bulkActionKey(op: PendingOperation): string {
  const ledger = registerBookedLedgerOf(op.operation_type, op.params)
  return ledger ? REGISTER_BOOKED_BULK_KEYS[ledger] : op.operation_type
}

/** The label of a bulkActionKey: a registration's key names its label (type_<key>). */
function bulkActionKeyLabel(key: string, t: (key: string) => string): string {
  return (Object.values(REGISTER_BOOKED_BULK_KEYS) as string[]).includes(key) ? t(`type_${key}`) : operationLabel(key, t)
}

/** How many of the operations each bulkActionKey has, in the order the keys first appear. */
function countByActionKey(ops: PendingOperation[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const op of ops) counts.set(bulkActionKey(op), (counts.get(bulkActionKey(op)) ?? 0) + 1)
  return Array.from(counts.entries())
}

function bulkActionLabel(operationType: string, count: number, t: (key: string) => string): string {
  const fn = bulkActionDescriptions[operationType]
  if (fn) return fn(count)
  return `${count} × ${operationLabel(operationType, t)}.`
}

// The daily batches (lib/pending-operations/daily-batches) on a pending row:
// what its approve button says (it opens the batch's review dialog, it does
// not approve).
const DAILY_BATCH_REVIEW_LABEL_KEY: Record<DailyBatchType, string> = {
  collections_daily_batch: 'review_collections_batch',
  reminder_daily_batch: 'review_reminder_batch',
}
// The two review dialogs open on a click ("Granska"): loaded then, not with the list.
const HandoverBatchDialog = dynamic(() => import('@/components/collections/HandoverBatchDialog').then((m) => m.HandoverBatchDialog))
const ReminderBatchDialog = dynamic(() => import('@/components/reminders/ReminderBatchDialog').then((m) => m.ReminderBatchDialog))
const DAILY_BATCH_DIALOG: Record<DailyBatchType, ComponentType<ComponentProps<typeof ReminderBatchDialogType>>> = {
  collections_daily_batch: HandoverBatchDialog,
  reminder_daily_batch: ReminderBatchDialog,
}

// The lock that stops a waiting proposal's approval, attached to
// preview_data by the list route when the date the approval posts on is
// locked now (StagedPeriodLock, lib/pending-operations/period-lock.ts). Read
// on every list load, never stored: unlocking makes the proposal approvable.
interface PeriodStatusShape {
  period_id: string | null
  status: 'open' | 'locked' | 'closed'
  /** The company lock date ("låst t.o.m."); null when the year's own lock or closing stops it. */
  lock_date: string | null
  /** The date the approval would post on. */
  date: string | null
}

function getPeriodStatus(op: PendingOperation): PeriodStatusShape | null {
  const raw = (op.preview_data as Record<string, unknown>)?.period_status
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const status = obj.status
  if (status !== 'open' && status !== 'locked' && status !== 'closed') return null
  return {
    period_id: typeof obj.period_id === 'string' ? obj.period_id : null,
    status,
    lock_date: typeof obj.lock_date === 'string' ? obj.lock_date : null,
    date: typeof obj.date === 'string' ? obj.date : null,
  }
}

/** Why a proposal in a locked or closed period cannot be approved, as its row's one line. */
function periodLockRowText(
  period: PeriodStatusShape,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  if (period.status === 'closed') return t('period_row_closed')
  return period.lock_date ? t('period_row_locked_through', { date: formatDate(period.lock_date) }) : t('period_row_locked')
}

/**
 * Whether an operation may join a bulk approval: pending, in an open period,
 * and not high risk unless it belongs to a group one acknowledgment covers
 * (lib/pending-operations/shared-acknowledgment.ts, crm#1489). The bulk
 * dialog asks for that acknowledgment; without it those rows are left out.
 * A proposal that lacks a required field is approved nowhere (the review
 * template's rule, review-model.ts missingFields), so it joins no bulk either.
 */
function isBulkSelectable(op: PendingOperation): boolean {
  if (op.status !== 'pending') return false
  if (missingFields(op).length > 0) return false
  if (op.risk_level === 'high' && sharedAcknowledgmentGroup(op) == null) return false
  const period = getPeriodStatus(op)
  return !(period && period.status !== 'open')
}

// The shared acknowledgment's title and amount labels per what it covers:
// bank samlingsverifikat (crm#1489), webshop orders (I12), or both.
const SHARED_ACK_LABEL_KEYS = {
  bank: { title: 'shared_ack_title', incoming: 'shared_ack_incoming', outgoing: 'shared_ack_outgoing' },
  webshop: { title: 'shared_ack_title_webshop', incoming: 'shared_ack_orders', outgoing: 'shared_ack_refunds' },
  mixed: { title: 'shared_ack_title_mixed', incoming: 'shared_ack_amount_in', outgoing: 'shared_ack_amount_out' },
} as const

/** One operation's outcome in a bulk approval (bulk-commit route). */
interface BulkItemResult {
  id: string
  status: 'committed' | 'failed' | 'skipped' | 'rejected'
  error?: string
}

const SORT_ORDER_STORAGE_KEY = 'pending.sortOrder'
const APPROVAL_RESULTS_STORAGE_KEY = 'pending.approvalResults'
const SHOW_PROPOSAL_EVENT = 'pending:show-proposal'
// Operations per page of a status stream, and the most the list API returns
// per request (PendingOperationsQuerySchema).
const LIST_PAGE_SIZE = 50
const PENDING_API_MAX_LIMIT = 100

/**
 * Human origin line for a staged operation. Many reviewers never used the AI
 * chat themselves (a colleague or consultant did), so the raw actor_label is
 * not enough context: name the agent and the person it worked for ("Claude
 * åt Jonas Ek", lib/attribution), never the credential it came through.
 * A connector arrives as actor_type='mcp_oauth' (api_key on rows staged before
 * 2026-11-01) with its client's label; op.user_id is the person (a service
 * account's sponsor, whoever chatted).
 */
function originLabel(
  op: PendingOperation,
  t: (key: string, values?: Record<string, string>) => string,
  attribute: (actor: ActorRef, options?: AttributionOptions) => string,
): string | null {
  switch (op.actor_type) {
    case 'agent_chat':
    case 'mcp_oauth':
    case 'api_key':
    case 'service_account':
      return t('origin_agent', {
        who: attribute({ actorType: op.actor_type, actorLabel: op.actor_label, userId: op.user_id }, { inline: true }),
      })
    case 'cron':
      return t('origin_cron')
    // A suggestion a detector staged on its own (lib/suggestions).
    case 'system':
      return t('origin_system')
    default:
      return null
  }
}

/**
 * failed_partial rows (issue #842): the executor posted an irreversible
 * voucher/credit note and then failed a later step. The dispatcher persisted
 * the ids of what WAS posted in result_data.posted_ids; render them so the
 * reviewer can locate the orphaned entity.
 */
function failedPartialPostedIds(op: PendingOperation): string | null {
  const rd = op.result_data as { posted_ids?: Record<string, string> } | null
  const entries = Object.entries(rd?.posted_ids ?? {})
  if (entries.length === 0) return null
  return entries.map(([key, value]) => `${key}: ${value}`).join(', ')
}

function formatRelativeTime(dateStr: string, t: (key: string, values?: Record<string, number>) => string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return t('time_just_now')
  if (diffMin < 60) return t('time_minutes_ago', { count: diffMin })
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return t('time_hours_ago', { count: diffHours })
  return t('time_days_ago', { count: Math.floor(diffHours / 24) })
}

/**
 * Account number -> account name, for the proposal previews.
 *
 * A preview line showed the account number next to the line's own description,
 * so "5890 Utlägg Norwegian" hid the fact that 5890 is Övriga resekostnader.
 * The number alone is not readable and the description is not the account, so
 * approving meant trusting a label that never named what was being debited.
 *
 * Owned by the page rather than a module-level cache: the map is per company,
 * and a cache that outlives the page would keep serving one company's account
 * names after a switch. A failed fetch leaves the map empty, which shows the
 * bare number rather than a wrong name, and retries on the next mount.
 */

/**
 * Inline period-lock banner. Renders when the date the approval would post
 * on is locked or closed: the server's commit-time trigger will reject it, so
 * we tell the approver up front rather than letting them click and see the
 * proposal closed by the refusal. The help names where that lock is lifted:
 * the company lock date under Inställningar, Bokföring; a year's own lock
 * under Inställningar, Räkenskapsår; a closed year nowhere.
 */
function PeriodLockBanner({ period }: { period: PeriodStatusShape }) {
  const t = useTranslations('pending')
  const lockedThrough = period.lock_date ? formatDate(period.lock_date) : null
  const help =
    period.status === 'closed'
      ? t('period_closed_help')
      : lockedThrough && period.date
        ? t('period_locked_through_help', { date: formatDate(period.date) })
        : t('period_locked_help')
  return (
    <div className="flex items-start gap-2 text-[13px]" role="note">
      <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-strong">
          {period.status === 'closed'
            ? t('period_closed_title')
            : lockedThrough
              ? t('period_locked_through', { date: lockedThrough })
              : t('period_locked_title')}
        </p>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
    </div>
  )
}

/**
 * The amount a proposal names, in the list's amount column: plain figures as
 * in every list row (no "kr"), another currency with its code. An empty cell
 * of the same width where it names none, so the columns stay in line.
 */
function RowAmount({ op }: { op: PendingOperation }) {
  const amount = headlineAmount(op)
  return (
    <span className="w-28 shrink-0 whitespace-nowrap text-right text-[13px] tabular-nums text-strong max-sm:w-auto" data-ph-mask="">
      {amount
        ? amount.currency && !isLedgerCurrency(amount.currency)
          ? formatCurrency(amount.value, amount.currency)
          : formatAmount(amount.value)
        : null}
    </span>
  )
}

/**
 * A staged title as the list reads it: its leading type ("Manuell
 * verifikation:") and the part that identifies the item. A title with no
 * such prefix is all name.
 */
function splitRowTitle(title: string): { type: string | null; name: string } {
  const cut = title.indexOf(': ')
  return cut > 0 && cut <= 30 && cut + 2 < title.length ? { type: title.slice(0, cut + 1), name: title.slice(cut + 2) } : { type: null, name: title }
}

type SourceFilter = 'all' | 'agent' | 'high_risk'

// Concept scene 11: two views. Historik merges committed + rejected,
// distinguished per row by a status chip.
type ViewTab = 'pending' | 'history'

// The spot check before "Godkänn alla" (Att göra V8): /pending?vy=stickprov.
const SPOT_CHECK_QUERY = 'vy'
const SPOT_CHECK_VALUE = 'stickprov'
const SPOT_CHECK_REASON_KEY: Record<SpotCheckReason, string> = {
  warning: 'spot_reason_warning',
  largest: 'spot_reason_largest',
  raised_risk: 'spot_reason_raised_risk',
  random: 'spot_reason_random',
}

/** The calendar day a proposal was staged (its run), yyyy-MM-dd in local time. */
function stagedDay(op: PendingOperation): string {
  const d = new Date(op.created_at)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function PendingOperationsPage() {
  const t = useTranslations('pending')
  const tCollections = useTranslations('collections')
  const tReminders = useTranslations('reminders')
  const tSkills = useTranslations('skills_registry')
  const tCommon = useTranslations('common')
  const tSigning = useTranslations('skv_signing')
  // A read-only member reads the queue; every approve and reject control is locked.
  const { canWrite, lockedTitle } = useViewerLock()
  const { format: attribute } = useAttribution()
  const complianceWarningText = useComplianceWarningText()
  const router = useRouter()
  const accountNames = useAccountNamesSource()
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The last fetch failed: 'initial' when no rows of this tab are on screen
  // (the list says so in their place), 'refresh' when this tab's rows stay
  // and one line above them says the refresh failed.
  const [loadError, setLoadError] = useState<'initial' | 'refresh' | null>(null)
  const [activeTab, setActiveTab] = useState<ViewTab>('pending')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  // Queue order. Newest first by default; a bokslut batch is approved oldest
  // first, so the choice is remembered per browser.
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SORT_ORDER_STORAGE_KEY)
      if (stored === 'asc' || stored === 'desc') setSortOrder(stored)
    } catch {
      // Storage blocked: keep the default.
    }
  }, [])
  const toggleSortOrder = () => {
    setSortOrder((prev) => {
      const next = prev === 'desc' ? 'asc' : 'desc'
      try {
        window.localStorage.setItem(SORT_ORDER_STORAGE_KEY, next)
      } catch {
        // Storage blocked: the toggle still applies for this session.
      }
      return next
    })
  }
  const [conversationFilter, setConversationFilter] = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  // The spot check (Rutin, Att göra V8): "Godkänn N förslag" first shows a few
  // of them to look at; the approval of all opens once the person says they
  // have looked. The approval itself is the bulk dialog below, unchanged.
  const [spotCheck, setSpotCheckState] = useState(false)
  const [spotChecked, setSpotChecked] = useState(false)
  const setSpotCheck = (on: boolean) => {
    setSpotCheckState(on)
    setSpotChecked(false)
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (on) url.searchParams.set(SPOT_CHECK_QUERY, SPOT_CHECK_VALUE)
    else url.searchParams.delete(SPOT_CHECK_QUERY)
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
  }
  // Detail slide-over (convention 13): id rather than the row object, so the
  // panel tracks realtime refetches and closes itself when the op leaves the
  // current list (approved elsewhere, tab switch, filter change).
  const [detailOpId, setDetailOpId] = useState<string | null>(null)
  // The full-page review of one proposal (/pending/[id]): this same page,
  // walking the queue one proposal at a time on the review template. The
  // step is state, mirrored into the address with replaceState: a route
  // change would remount the page and drop the approvals still in its queue.
  const routeParams = useParams<{ id?: string }>()
  const reviewMode = typeof routeParams?.id === 'string'
  const [reviewId, setReviewId] = useState<string | null>(routeParams?.id ?? null)
  // The linked proposal is not waiting any more (approved or rejected elsewhere).
  const [reviewGone, setReviewGone] = useState(false)
  // The queue's order while the proposal on screen was still in it: where
  // the walk goes once it leaves.
  const reviewOrderRef = useRef<string[]>([])
  // The address follows the step. replaceState with no state of its own is
  // the call the router listens to (handing back history.state, which
  // carries the router's own marks, is taken for one of its own calls and
  // ignored): otherwise the next router.refresh() puts back the address of
  // the proposal that was just resolved. An effect on the path, so a refresh
  // already under way when the step moved cannot leave the old address.
  const pathname = usePathname()
  useEffect(() => {
    if (!reviewMode || !reviewId || typeof window === 'undefined') return
    const wanted = `/pending/${reviewId}`
    if (pathname !== wanted) window.history.replaceState(null, '', `${wanted}${window.location.search}`)
  }, [reviewMode, reviewId, pathname])
  const [selectedOp, setSelectedOp] = useState<PendingOperation | null>(null)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  // Approvals given but not yet answered. The row leaves the list on the
  // click and the approvals run one at a time in click order, so the next
  // row's Godkänn answers at once instead of waiting on this one (one shared
  // in-flight flag used to disable every row's button meanwhile, and the
  // clicks on it went nowhere). A refused approval brings its row back.
  const [approvingIds, setApprovingIds] = useState<ReadonlySet<string>>(new Set())
  const approvalChain = useRef<Promise<void>>(Promise.resolve())
  const approvalsLeft = useRef(0)
  // Approvals the booking's duplicate guard stopped: the proposal is still
  // pending, and the person answers the possible duplicate here (match it,
  // book anyway, or leave it). One dialog at a time, in the order they came.
  const [duplicatePrompts, setDuplicatePrompts] = useState<
    Array<{ op: PendingOperation; candidate: BookedDuplicateCandidate }>
  >([])
  // Radix' onCheckedChange carries no mouse event: the preceding click records
  // whether shift was held, for range selection.
  const shiftHeld = useRef(false)
  const [showBulkDialog, setShowBulkDialog] = useState(false)
  const [isBulkCommitting, setIsBulkCommitting] = useState(false)
  // The one explicit acknowledgment the bulk dialog asks for before routine
  // high-risk operations join the approval (crm#1489). Cleared on every open.
  const [groupAcknowledged, setGroupAcknowledged] = useState(false)
  // What a bulk approval left undone, per operation and why (crm#1488): shown
  // in a dialog instead of a count toast.
  const [bulkOutcome, setBulkOutcome] = useState<{
    summary: string
    items: Array<{ id: string; title: string; reason: string | null }>
    draftsHint: boolean
  } | null>(null)
  // Reject dialog state: separate from the generic destructive-confirm so we
  // can ask for a category + free-text reason that feeds back to the agent.
  // 'bulk' targets the current checkbox selection instead of a single op.
  const [rejectTarget, setRejectTarget] = useState<PendingOperation | 'bulk' | null>(null)
  // The daily batches (the collections run, the reminders) are reviewed in
  // their own dialog (items to untick, the ones left out, what was sent),
  // never through the generic approval card. Att göra links here with
  // ?review=<type> to open one.
  const [batchReview, setBatchReview] = useState<{ id: string; type: DailyBatchType } | null>(null)
  const batchReviewRequested = useRef<DailyBatchType | null>(null)
  const [isRejecting, setIsRejecting] = useState(false)
  // An approved Skatteverket filing is locked there, not filed: its BankID
  // signing link opens in a dialog right after the approval (crm#1478).
  const [signingPrompt, setSigningPrompt] = useState<{ title: string; url: string } | null>(null)
  // An approval refused for something the person fixes around the proposal:
  // the proposal is still pending. The row says what to fix (by refusal
  // code) until the approval goes through; a create_voucher refused for its
  // booking-time warnings shows them for the person to confirm.
  const [fixNotes, setFixNotes] = useState<Record<string, string>>({})
  // Approvals that did not go through, per proposal (approval-results.ts):
  // the proposal still waits, and its row, its place in the queue and the
  // review's bar say what the server answered. It is said once to a screen
  // reader by the toast (a live region that names the proposal and the
  // sentence), which lives outside this page and so outlasts its remounts.
  const [approvalResults, setApprovalResults] = useState<ApprovalResults>(NO_APPROVAL_RESULTS)
  // Kept for the tab: the list and the review are two mounts of this page,
  // and a refusal must still be on its proposal after going from one to the other.
  useEffect(() => {
    try {
      const kept = parseStoredResults(window.sessionStorage.getItem(APPROVAL_RESULTS_STORAGE_KEY))
      if (Object.keys(kept).length > 0) setApprovalResults((prev) => ({ ...kept, ...prev }))
    } catch {
      // Storage blocked: the record lives for this mount only.
    }
  }, [])
  const approvalResultsRead = useRef(false)
  useEffect(() => {
    // Not on the first pass: it would write the empty start over what the tab kept.
    if (!approvalResultsRead.current) {
      approvalResultsRead.current = true
      return
    }
    try {
      window.sessionStorage.setItem(APPROVAL_RESULTS_STORAGE_KEY, JSON.stringify(approvalResults))
    } catch {
      // Storage blocked.
    }
  }, [approvalResults])
  function noteFailure(op: Pick<PendingOperation, 'id' | 'title'>, failure: ApprovalFailure) {
    setApprovalResults((prev) => recordFailure(prev, op.id, failure))
  }
  // The toast's way to the proposal: the walk steps to it, the list opens the
  // walk on it. Asked for through an event, not a closure: the walk's step to
  // the next proposal can remount this page while the toast is still up, and
  // the toast must reach the page that is mounted when it is pressed.
  useEffect(() => {
    const onShow = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id !== 'string') return
      if (reviewMode) {
        setReviewGone(false)
        setReviewId(id)
      } else {
        router.push(`/pending/${id}`)
      }
    }
    window.addEventListener(SHOW_PROPOSAL_EVENT, onShow)
    return () => window.removeEventListener(SHOW_PROPOSAL_EVENT, onShow)
  }, [reviewMode, router])
  const showInWalk = (id: string) => window.dispatchEvent(new CustomEvent(SHOW_PROPOSAL_EVENT, { detail: id }))
  // One dialog at a time, in the order the approvals answered: the queue can
  // bring a second one while the first is being read.
  const [voucherConfirms, setVoucherConfirms] = useState<Array<{ op: PendingOperation; warnings: VoucherWarning[] }>>([])
  const { toast } = useToast()
  // Whether the "Bokför utkasten" toast CTA leads anywhere: bulk Bokför on
  // /invoices only selects drafts when the company books at issue. Under
  // kontantmetoden or deferred booking (#967) the CTA would be a dead end,
  // so it stays suppressed (false until settings load: suppressing is the
  // safe direction, the neutral hint sentence still shows).
  // Derived from the session-cached settings row (lib/reference-data); false
  // until the row is available, suppressing being the safe direction.
  const { settings: companySettings } = useCompanySettings()
  const companyId = useCompanyOptional()?.company?.id ?? null
  const invoiceDraftsCtaUseful = companySettings ? booksInvoicesOnIssue(companySettings) : false

  // Read ?conversation= once on mount so deep-links from the agent context
  // strip filter the list automatically.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const conv = url.searchParams.get('conversation')
    if (conv) setConversationFilter(conv)
    if (url.searchParams.get(SPOT_CHECK_QUERY) === SPOT_CHECK_VALUE) setSpotCheckState(true)
    const review = wantsBatchReview(url.search)
      ? COLLECTIONS_BATCH_TYPE
      : wantsReminderBatchReview(url.search)
        ? REMINDER_BATCH_TYPE
        : null
    if (review) {
      batchReviewRequested.current = review
      // Once: a reload or the back button should not reopen the dialog.
      url.searchParams.delete(BATCH_REVIEW_QUERY)
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
    }
  }, [])

  // Which tab the rows in `operations` belong to, and whether anything is on
  // screen: lets refetches decide between the first-load takeover and a
  // background reconcile without making row state a useCallback dependency
  // (which would re-subscribe the realtime channel on every data change).
  const loadedTabRef = useRef<ViewTab | null>(null)
  const hasRowsRef = useRef(false)
  // The rows as they are now, for an approval that answers after the list
  // has moved on (the queue outlives the render that started it).
  const operationsRef = useRef<PendingOperation[]>([])
  useEffect(() => {
    hasRowsRef.current = operations.length > 0
    operationsRef.current = operations
  }, [operations])
  // Background reconcile in flight: drives the quiet toolbar cue.
  const [isRefreshing, setIsRefreshing] = useState(false)
  // Monotonic request sequence: a fetch kicked off for a previous tab (or an
  // older realtime echo) can resolve after the current one. Only the latest
  // request may touch rows, counts, refs, toasts, or loading cues; stale
  // responses bail out and leave the newer request's state alone.
  const fetchSequenceRef = useRef(0)

  // Rows loaded per status stream. "Ladda fler" grows it; a refetch (an
  // approval, a realtime echo) reloads the whole grown window in chunks so it
  // never collapses back to the first page. A new tab or sort order starts
  // from one page again: the window belongs to the view it was grown in.
  const viewKey = `${activeTab}:${sortOrder}`
  const [listWindow, setListWindow] = useState({ viewKey, size: LIST_PAGE_SIZE })
  const windowSize = listWindow.viewKey === viewKey ? listWindow.size : LIST_PAGE_SIZE
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const loadMore = () => {
    setIsLoadingMore(true)
    setListWindow({ viewKey, size: windowSize + LIST_PAGE_SIZE })
  }

  const fetchOperations = useCallback(async () => {
    const sequence = ++fetchSequenceRef.current
    const isCurrent = () => sequence === fetchSequenceRef.current
    // The list-for-spinner swap is reserved for a first load or a tab whose
    // rows aren't on screen yet. Approving/rejecting a row (and its realtime
    // echo) used to run list → spinner → list → spinner → list: a whole-page
    // layout collapse plus a full stagger-enter replay, twice, for a
    // single-row change.
    const takeover = !hasRowsRef.current || loadedTabRef.current !== activeTab
    if (takeover) setIsLoading(true)
    else setIsRefreshing(true)
    try {
      // One status stream, collected up to the window in chunks the API
      // accepts. The tab counts ride along on every page.
      const tabCounts: { pending: number | null } = { pending: null }
      const loadStream = (status: 'pending' | 'committed' | 'rejected', order: 'asc' | 'desc') =>
        collectPages<PendingOperation>(
          async (offset, limit) => {
            const res = await fetch(
              `/api/pending-operations?status=${status}&order=${order}&limit=${limit}&offset=${offset}`,
            )
            // A JSON error body parses fine but carries no data: without this
            // check a failed refresh would blank the list and zero the badge
            // instead of keeping current rows and surfacing the error toast.
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const json = await res.json()
            if (typeof json.counts?.pending === 'number') tabCounts.pending = json.counts.pending
            return { data: (json.data ?? []) as PendingOperation[], count: json.count ?? null }
          },
          { want: windowSize, chunkSize: PENDING_API_MAX_LIMIT },
        )
      const moreThanLoaded = (stream: { data: unknown[]; count: number | null }) =>
        stream.count !== null && stream.count > stream.data.length

      if (activeTab === 'pending') {
        const pending = await loadStream('pending', sortOrder)
        if (!isCurrent()) return
        setOperations(pending.data)
        setPendingCount(pending.count ?? pending.data.length)
        setHasMore(moreThanLoaded(pending))
        loadedTabRef.current = 'pending'
      } else {
        // The API is single-status per fetch: Historik merges godkända and
        // avvisade, newest resolution first.
        const [committed, rejected] = await Promise.all([
          loadStream('committed', 'desc'),
          loadStream('rejected', 'desc'),
        ])
        if (!isCurrent()) return
        const merged = [...committed.data, ...rejected.data].sort(
          (a, b) => (b.resolved_at ?? b.created_at).localeCompare(a.resolved_at ?? a.created_at),
        )
        setOperations(merged)
        if (tabCounts.pending !== null) setPendingCount(tabCounts.pending)
        setHasMore(moreThanLoaded(committed) || moreThanLoaded(rejected))
        loadedTabRef.current = 'history'
      }
      setLoadError(null)
    } catch {
      if (!isCurrent()) return
      // The rows on screen belong to another tab (or no load has succeeded
      // yet): those foreign rows must not render under this tab's header as
      // if they were its content, so the load error takes their place.
      // Otherwise this tab's rows stay and a line above them says so.
      setLoadError(loadedTabRef.current !== activeTab ? 'initial' : 'refresh')
    }
    if (!isCurrent()) return
    setIsLoading(false)
    setIsRefreshing(false)
    setIsLoadingMore(false)
  }, [activeTab, sortOrder, windowSize])

  useEffect(() => {
    fetchOperations()
  }, [fetchOperations])

  // The Att göra row's deep link: open the pending batch once the pending
  // list has loaded (or drop the request when there is none any more).
  useEffect(() => {
    const wanted = batchReviewRequested.current
    if (!wanted || loadedTabRef.current !== 'pending') return
    batchReviewRequested.current = null
    const batch = operations.find((op) => pendingDailyBatchTypeOf(op) === wanted)
    if (batch) setBatchReview({ id: batch.id, type: wanted })
  }, [operations])

  /** A row's review surface: the batch dialog for a pending daily batch, else the detail slide-over. */
  function openReview(op: PendingOperation) {
    const type = pendingDailyBatchTypeOf(op)
    if (type) setBatchReview({ id: op.id, type })
    else setDetailOpId(op.id)
  }

  /**
   * A pending daily batch's row in its own words, with what it does as the
   * hover text; the staged title when its items cannot be read.
   */
  function dailyBatchRow(type: DailyBatchType, op: PendingOperation): { title: string; detail: string } {
    if (type === REMINDER_BATCH_TYPE) {
      const count = reminderRunItems(op.params).length
      return { title: count > 0 ? tReminders('batch_row', { count }) : op.title, detail: tReminders('batch_run_detail') }
    }
    const items = runItems(op.params)
    return {
      title: items.length > 0 ? capitalizeFirst(tCollections(batchRowKey(items), { count: items.length })) : op.title,
      detail: tCollections('batch_run_detail'),
    }
  }

  // Realtime subscription: refetch when ANY pending_operations row changes for
  // the active company. The filter is required: realtime applies the SELECT
  // policy, which is membership-wide, so without it a user in two companies
  // got the other company's events too. We refetch the whole list (rather than patching state
  // in-place) so server-side filtering, sorting, and computed fields stay in
  // sync with whatever the API route returned, including all tab counts.
  // Trailing debounce: bulk actions emit one event per row, which previously
  // stampeded 4 requests per event (list + 3 counts); the burst now collapses
  // into a single refetch after the last event.
  useEffect(() => {
    if (!companyId) return
    const supabase = createClient()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel(`pending_operations:list:${companyId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pending_operations',
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            fetchOperations()
            // The Granskning badge has no channel of its own any more.
            refreshWorklistBadges()
          }, 400)
        }
      )
    const stopJoin = subscribeAsUser(supabase, channel)
    return () => {
      if (debounce) clearTimeout(debounce)
      stopJoin()
      void supabase.removeChannel(channel)
    }
  }, [companyId, fetchOperations])

  // Resolving operations changes what Att göra counts, and Att göra is a
  // server render the client router keeps (staleTimes.dynamic in
  // next.config.ts, and every back/forward restore): without this the user
  // walked back to the counts from before the approvals and had to hard-reload
  // (crm#1003). router.refresh() drops those cached renders, the contract the
  // 30 s router cache was introduced under for every mutation flow. This list
  // reconciles through fetchOperations; the sidebar badges through this
  // page's realtime channel (refreshWorklistBadges).
  function afterResolve() {
    router.refresh()
    fetchOperations()
  }
  // The queue's last approval calls the current one: the tab or sort order
  // may have changed since the click that started it.
  const afterResolveRef = useRef(afterResolve)
  useEffect(() => {
    afterResolveRef.current = afterResolve
  })

  // An approved row leaves the list now, not when the refetch lands (seconds
  // on a long queue). Until then it stayed clickable: approving rows one by
  // one, the next click hit the row just approved again and got a 409 toast
  // for an approval that went through. The refetch reconciles.
  function dropFromList(id: string) {
    if (!operationsRef.current.some((o) => o.id === id)) return
    setOperations((prev) => prev.filter((o) => o.id !== id))
    setPendingCount((n) => (n === null ? n : Math.max(0, n - 1)))
  }

  // One approval, as the server answers it. Never throws: it runs inside the
  // queue, and what went wrong is said in a toast that names the proposal
  // (its row may be far from where the person is by then). What the person
  // answered after a first refusal rides along: the possible duplicate they
  // book over, or the booking-time warnings they confirmed.
  async function sendApproval(
    op: PendingOperation,
    expectedDuplicateJournalEntryId?: string,
    acknowledgedWarnings?: string[],
  ) {
    try {
      const res = await fetch(`/api/pending-operations/${op.id}/commit`, {
        method: 'POST',
        // The approval is given: leaving the page must not drop it.
        keepalive: true,
        ...(expectedDuplicateJournalEntryId || acknowledgedWarnings
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ...(expectedDuplicateJournalEntryId
                  ? { expected_duplicate_journal_entry_id: expectedDuplicateJournalEntryId }
                  : {}),
                ...(acknowledgedWarnings ? { acknowledged_warnings: acknowledgedWarnings } : {}),
              }),
            }
          : {}),
      })
      const json = await res.json().catch(() => ({}))
      const code = json?.error?.code
      // Already approved (another tab, or a second click), rejected, or being
      // approved right now: nothing ran and nothing failed. Say that, not
      // "Misslyckades", and let the row go.
      if (res.status === 409 && code === 'PENDING_OPERATION_NOT_PENDING') {
        toast({ title: t('already_resolved'), description: getErrorMessage(json, { statusCode: res.status }) })
        setApprovalResults((prev) => clearFailure(prev, op.id))
        dropFromList(op.id)
        return
      }
      // The ledger already seems to hold this affärshändelse. The proposal is
      // still pending; the person decides in the duplicate dialog.
      const candidate = json?.error?.details?.candidate as BookedDuplicateCandidate | undefined
      if (res.status === 409 && code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' && candidate) {
        setDuplicatePrompts((prev) => [...prev.filter((prompt) => prompt.op.id !== op.id), { op, candidate }])
        return
      }
      // A refusal that closed the proposal: said on its way out of the list.
      const refusal = res.ok ? null : readApprovalRefusal(json, res.status)
      if (refusal?.closed) return closeRefusedRow(op, refusal)
      // Still pending, and the person can fix it: the warnings to confirm,
      // or what to fix on the row.
      if (refusal && askToFixRefusal(op, refusal)) return
      // getErrorMessage handles both `{ error: string }` and the structured
      // `{ error: { code, message } }` envelope (the latter would otherwise
      // toast "[object Object]") and never surfaces raw English.
      if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))
      // The row leaving the list is the confirmation: no "Godkänd" toast. One
      // opened top-right, over the next row's Godkänn and Avvisa, and a
      // pointer resting there paused its timer, so approving rows in a row
      // meant closing a toast before each click (crm#1618). A filing that
      // still needs a BankID signature opens its signing step instead.
      const signingUrl = signingUrlOf(json.data)
      if (signingUrl) setSigningPrompt({ title: op.title, url: signingUrl })
      setApprovalResults((prev) => clearFailure(prev, op.id))
      dropFromList(op.id)
    } catch (err) {
      // The proposal still waits. What the server answered (or that no
      // answer came) stays on it, and the toast leads to it.
      const kind = failureKindOf(err)
      const message = kind === 'network' ? t('bulk_request_failed') : err instanceof Error ? getErrorMessage(err) : 'Okänt fel'
      noteFailure(op, { kind, message })
      toast({
        title: t('approve_failed', { title: op.title }),
        description: message,
        variant: 'destructive',
        action: (
          <ToastAction altText={t('refused_show')} onClick={() => showInWalk(op.id)}>
            {t('refused_show')}
          </ToastAction>
        ),
      })
    }
  }

  // Shared by the row's Godkänn, the slide-over and the high-risk
  // confirmation dialog. The Granskning row already states source, title and
  // risk and offers Detaljer, so for low/medium the click IS the deliberate
  // approval; only high risk keeps the dialog, whose warning sentence carries
  // information the row does not. The row leaves the list now; the returned
  // promise settles when the server has answered.
  function queueApproval(
    op: PendingOperation,
    expectedDuplicateJournalEntryId?: string,
    acknowledgedWarnings?: string[],
  ): Promise<void> {
    approvalsLeft.current += 1
    setApprovingIds((prev) => new Set(prev).add(op.id))
    selection.deselect([op.id])
    const run = approvalChain.current
      .then(() => sendApproval(op, expectedDuplicateJournalEntryId, acknowledgedWarnings))
      .finally(() => {
        setApprovingIds((prev) => {
          const next = new Set(prev)
          next.delete(op.id)
          return next
        })
        approvalsLeft.current -= 1
        // One reconcile for the whole run of clicks, not one per row.
        if (approvalsLeft.current === 0) afterResolveRef.current()
      })
    approvalChain.current = run
    return run
  }

  async function handleCommit() {
    if (!selectedOp) return
    setIsCommitting(true)
    await queueApproval(selectedOp)
    setIsCommitting(false)
    setShowCommitDialog(false)
    setSelectedOp(null)
  }

  const voucherConfirm = voucherConfirms[0] ?? null
  const closeVoucherConfirm = () => setVoucherConfirms((prev) => prev.slice(1))
  const duplicatePrompt = duplicatePrompts[0] ?? null
  const closeDuplicatePrompt = () => setDuplicatePrompts((prev) => prev.slice(1))
  const duplicatePromptTransactionId =
    typeof duplicatePrompt?.op.params?.transaction_id === 'string' ? duplicatePrompt.op.params.transaction_id : null

  /**
   * Approve a selection in request-sized chunks. The route takes at most 100
   * ids per request: "Godkänn alla" over a longer list used to send them all
   * at once, got a 400 back and showed "Något gick fel" with nothing approved
   * (crm#1488). Each chunk commits what it can; what was left undone is
   * listed per operation with its reason. A chunk the server refuses as a
   * whole (session, timeout) stops the run: the rest stays pending.
   */
  async function handleBulkCommit(ids: string[], acknowledgedGroups: SharedAcknowledgmentGroup[]) {
    if (ids.length === 0) return
    setIsBulkCommitting(true)
    const results: BulkItemResult[] = []
    const chunks = chunkIds(ids)
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      let chunkError: string | null = null
      try {
        const res = await fetch('/api/pending-operations/bulk-commit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: chunk,
            ...(acknowledgedGroups.length > 0 ? { acknowledged_groups: acknowledgedGroups } : {}),
          }),
        })
        const json = await res.json().catch(() => ({}))
        if (res.ok) {
          results.push(...((json.data?.results ?? []) as BulkItemResult[]))
        } else {
          chunkError = getErrorMessage(json, { statusCode: res.status })
        }
      } catch {
        chunkError = t('bulk_request_failed')
      }
      if (chunkError !== null) {
        for (const id of chunk) results.push({ id, status: 'failed', error: chunkError })
        for (const id of chunks.slice(index + 1).flat()) {
          results.push({ id, status: 'skipped', error: t('bulk_not_attempted') })
        }
        break
      }
    }

    const count = (status: BulkItemResult['status']) => results.filter((r) => r.status === status).length
    const summary = { committed: count('committed'), failed: count('failed'), skipped: count('skipped'), rejected: count('rejected') }
    const parts: string[] = []
    if (summary.committed > 0) parts.push(`${summary.committed} godkända`)
    if (summary.failed > 0) parts.push(`${summary.failed} misslyckades`)
    if (summary.rejected > 0) parts.push(`${summary.rejected} avvisade`)
    if (summary.skipped > 0) parts.push(`${summary.skipped} hoppades över`)

    // Committed create_invoice ops land as unnumbered DRAFTS: point the
    // user at the draft view where bulk Bokför finishes the job.
    const committedIds = new Set(results.filter((r) => r.status === 'committed').map((r) => r.id))
    const committedInvoiceDrafts = operations.some(
      (op) => committedIds.has(op.id) && bulkActionKey(op) === 'create_invoice',
    )

    const undone = results.filter((r) => r.status !== 'committed')
    if (undone.length > 0) {
      // A row the server tried and refused still waits: it carries the reason.
      // One that was never tried (skipped) is not marked as refused.
      setApprovalResults((prev) =>
        recordFailures(
          prev,
          undone
            .filter((r) => r.status === 'failed' && r.error)
            .map((r) => ({ id: r.id, failure: { kind: 'refused' as const, message: r.error as string } })),
        ),
      )
      // Look-alike titles are told apart by the proposal's number.
      const titles = new Map(operations.map((op) => [op.id, [proposalNumberLabel(op, t), op.title].filter(Boolean).join(' · ')]))
      setBulkOutcome({
        summary: parts.join(', '),
        items: undone.map((r) => ({ id: r.id, title: titles.get(r.id) ?? r.id, reason: r.error ?? null })),
        draftsHint: committedInvoiceDrafts && invoiceDraftsCtaUseful,
      })
    } else {
      const draftsCta = committedInvoiceDrafts && invoiceDraftsCtaUseful
        ? {
            action: (
              <ToastAction
                altText={t('bulk_invoice_drafts_cta')}
                onClick={() => router.push('/invoices?status=draft')}
              >
                {t('bulk_invoice_drafts_cta')}
              </ToastAction>
            ),
          }
        : {}
      toast({
        title: 'Godkänt',
        description: committedInvoiceDrafts ? `${parts.join(', ')}. ${t('bulk_invoice_drafts_hint')}` : parts.join(', '),
        ...draftsCta,
      })
    }

    setShowBulkDialog(false)
    selection.clear()
    // The spot check led here: the approval is given, back to the list.
    if (spotCheck) setSpotCheck(false)
    afterResolve()
    setIsBulkCommitting(false)
  }

  // An approval the executor refused in a way that closed the proposal
  // (tracker #206): say so and let the row go, so a second Godkänn is not
  // offered on it (it answered "Redan hanterad"). Historik keeps the
  // proposal with the reason. Runs inside the approval queue, which
  // deselects the row, closes the confirm dialog and refetches once drained.
  function closeRefusedRow(op: PendingOperation, refusal: ApprovalRefusal) {
    toast({ title: t('refusal_closed_title'), description: refusal.message, variant: 'destructive' })
    dropFromList(op.id)
  }

  // An approval refused for something the person fixes around the proposal
  // (fixable-refusals.ts): the proposal is still pending. A voucher's
  // booking-time warnings open for the person to confirm; anything else is
  // said on the row with the link to the fix. False when the refusal is not
  // one of those: the caller then reports it as a plain failure.
  function askToFixRefusal(op: PendingOperation, refusal: ApprovalRefusal): boolean {
    const fix = fixableRefusalFor(op.operation_type, refusal.code)
    if (!fix || !refusal.code) return false
    const warnings = refusal.details.warnings
    if (refusal.code === 'VOUCHER_NEEDS_CONFIRMATION' && Array.isArray(warnings) && warnings.length > 0) {
      const prompt = { op, warnings: warnings as VoucherWarning[] }
      setVoucherConfirms((prev) => [...prev.filter((waiting) => waiting.op.id !== op.id), prompt])
      return true
    }
    const copy = FIXABLE_REFUSAL_COPY[refusal.code]
    if (!copy) return false
    setFixNotes((prev) => ({ ...prev, [op.id]: refusal.code as string }))
    noteFailure(op, { kind: 'refused', message: copy.noteInToast ? t(copy.note) : refusal.message, fixCode: refusal.code })
    toast({
      title: t('refusal_fix_title'),
      description: copy.noteInToast ? t(copy.note) : refusal.message,
      ...(fix.fixHref
        ? {
            action: (
              <ToastAction altText={t(copy.link)} onClick={() => router.push(fix.fixHref as string)}>
                {t(copy.link)}
              </ToastAction>
            ),
          }
        : {}),
    })
    return true
  }

  function openRejectDialog(target: PendingOperation | 'bulk') {
    setRejectTarget(target)
  }

  async function handleReject(feedback: RejectFeedback) {
    if (!rejectTarget) return
    setIsRejecting(true)
    try {
      if (rejectTarget === 'bulk') {
        // Same 100-id cap as bulk approval (crm#1488): send request-sized
        // chunks and add up their summaries.
        let summary: { rejected: number; skipped: number; failed: number } | undefined
        for (const chunk of chunkIds(Array.from(selection.selectedIds))) {
          const res = await fetch('/api/pending-operations/bulk-reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: chunk, ...feedback }),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))
          const part = json.data?.summary as { rejected: number; skipped: number; failed: number } | undefined
          if (part) {
            summary = {
              rejected: (summary?.rejected ?? 0) + part.rejected,
              skipped: (summary?.skipped ?? 0) + part.skipped,
              failed: (summary?.failed ?? 0) + part.failed,
            }
          }
        }
        if (summary) {
          const parts: string[] = []
          if (summary.rejected > 0) parts.push(`${summary.rejected} avvisade`)
          if (summary.skipped > 0) parts.push(`${summary.skipped} hoppades över`)
          if (summary.failed > 0) parts.push(`${summary.failed} misslyckades`)
          toast({
            title: summary.failed > 0 ? 'Klart med fel' : 'Avvisade',
            description: parts.join(', '),
            variant: summary.failed > 0 ? 'destructive' : 'default',
          })
        } else {
          toast({ title: 'Avvisade' })
        }
        selection.clear()
      } else {
        const res = await fetch(`/api/pending-operations/${rejectTarget.id}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(feedback),
        })
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          throw new Error(getErrorMessage(json, { statusCode: res.status }))
        }
        toast({ title: 'Avvisad', description: rejectTarget.title })
      }

      setRejectTarget(null)
      afterResolve()
    } catch (err) {
      toast({
        title: 'Kunde inte avvisa',
        description: err instanceof Error ? getErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    }
    setIsRejecting(false)
  }

  const matchingOperations = operations.filter((op) => {
    // Approved on the click: gone until the server says otherwise.
    if (approvingIds.has(op.id)) return false
    if (conversationFilter && op.agent_metadata?.conversation_id !== conversationFilter) {
      return false
    }
    switch (sourceFilter) {
      case 'agent':
        return (
          op.actor_type === 'api_key' ||
          op.actor_type === 'mcp_oauth' ||
          op.actor_type === 'service_account' ||
          op.actor_type === 'cron' ||
          op.actor_type === 'agent_chat' ||
          op.actor_type === 'system'
        )
      case 'high_risk':
        return op.risk_level === 'high'
      case 'all':
      default:
        return true
    }
  })

  // Väntar reads per run: the proposals one source staged on one day sit
  // together under a band with their count. Runs keep the order their first
  // proposal has in the chosen sort; within a run the sort order stands.
  // Everything below (selection ranges, the bulk order) follows this order.
  // Who staged a proposal, when it was not the person: the attribution line,
  // else the actor's own label (originOf), else its bare type (stagerOf).
  const originOf = (op: PendingOperation) =>
    op.actor_type && op.actor_type !== 'user' ? (originLabel(op, t, attribute) ?? op.actor_label ?? null) : null
  const stagerOf = (op: PendingOperation) => originOf(op) ?? (op.actor_type && op.actor_type !== 'user' ? op.actor_type : null)
  const runKeyOf = (op: PendingOperation) => `${stagerOf(op) ?? ''}|${stagedDay(op)}`
  /** A run's band: who staged it and which day. */
  const runLabel = (first: PendingOperation) =>
    `${originOf(first) ?? t('run_manual')}${stagedDay(first) ? `, ${formatDate(stagedDay(first))}` : ''}`
  /** Who a run's band names, once and short: the agent and the person it worked for, without "Föreslaget av". */
  const runWho = (first: PendingOperation) => {
    switch (first.actor_type) {
      case 'agent_chat':
      case 'mcp_oauth':
      case 'api_key':
      case 'service_account':
        return attribute({ actorType: first.actor_type, actorLabel: first.actor_label, userId: first.user_id })
      default:
        return originOf(first) ?? t('run_manual')
    }
  }
  const runs: Array<{ key: string; ops: PendingOperation[] }> = []
  if (activeTab === 'pending') {
    const byKey = new Map<string, PendingOperation[]>()
    for (const op of matchingOperations) {
      const key = runKeyOf(op)
      const run = byKey.get(key)
      if (run) run.push(op)
      else {
        const ops = [op]
        byKey.set(key, ops)
        runs.push({ key, ops })
      }
    }
  }
  const filteredOperations = activeTab === 'pending' ? runs.flatMap((run) => run.ops) : matchingOperations
  const runStarts = new Map(runs.map((run) => [run.ops[0].id, run]))

  const showBulkControls = activeTab === 'pending'
  // Pending ops that meet two criteria: not high risk (bar the groups one
  // acknowledgment covers) AND the period covering them is open. We exclude
  // locked/closed periods from bulk because they will be rejected at commit
  // time anyway: silently letting the user "select all" and watching some
  // fail is a worse UX than excluding them up front.
  const bulkEligible = filteredOperations.filter(isBulkSelectable)
  // The selection holds only bulk-eligible operations of the current view: a
  // tab, filter or refetch that hides one (approved elsewhere, its period
  // locked) drops it, so the bar and the bulk calls never carry it.
  const selection = useBulkSelection(bulkEligible.map((op) => op.id))
  const selectedIds = selection.selectedIds

  const pendingTotal = filteredOperations.filter((op) => op.status === 'pending').length
  const excludedFromBulk = pendingTotal - bulkEligible.length

  // "Approve all of this type": find bulk-eligible ops with the same bulkActionKey
  function selectAllOfType(key: string) {
    selection.selectOnly(bulkEligible.filter((op) => bulkActionKey(op) === key).map((op) => op.id))
  }

  // What approving everything does, from the proposals a bulk approval
  // takes (never from the selection); the quick "all of this type" links
  // show for a type with two or more.
  const eligibleBreakdown = countByActionKey(bulkEligible)
  const typeCounts = eligibleBreakdown.filter(([, count]) => count >= 2)

  const selectedCount = selectedIds.size

  const spotCheckOpen = spotCheck && activeTab === 'pending' && bulkEligible.length > 0
  // The spot check's sample, from the same proposals.
  const spotSample = spotCheckOpen ? pickSpotCheck(bulkEligible, (op) => complianceWarningOf(op) != null) : []
  function openApproveAll() {
    selection.selectAll()
    setGroupAcknowledged(false)
    setShowBulkDialog(true)
  }

  // Selected high-risk operations that join only under the dialog's one
  // acknowledgment (crm#1489), and what that acknowledgment approves.
  const selectedOps = bulkEligible.filter((op) => selectedIds.has(op.id))
  const selectedGroupOps = selectedOps.filter((op) => op.risk_level === 'high')
  const groupSummary = summarizeSharedAcknowledgment(selectedGroupOps)
  // What the acknowledgment names: bank samlingsverifikat, webshop orders, or both.
  const ackGroups = new Set(selectedGroupOps.map(sharedAcknowledgmentGroup))
  const groupKind: keyof typeof SHARED_ACK_LABEL_KEYS = ackGroups.size !== 1 ? 'mixed' : ackGroups.has('webshop_order_book') ? 'webshop' : 'bank'
  const bulkConfirmCount = selectedCount - (groupAcknowledged ? 0 : selectedGroupOps.length)

  const selectedBreakdown = countByActionKey(selectedOps.filter((op) => op.risk_level !== 'high'))

  // Selected operations that carry a compliance warning. The bulk
  // confirmation says how many, so "Godkänn alla" cannot carry a warning past
  // an approver who never scrolled to its row (crm#1003).
  const selectedWarnedCount = selectedOps.filter((op) => complianceWarningOf(op) != null).length

  // The instructions the agent retrieved, by the names the Instruktioner page uses: never raw slugs or uuids.
  const retrievedNames = (slugs: readonly string[]) => [...new Set(describeRetrievedSkills(slugs).map((item) => {
    if (item.kind === 'workflow') return tSkills(`skills.${item.id}.name`)
    if (item.kind === 'own') return tSkills('retrieved_own')
    const key = item.kind === 'knowledge' ? `knowledge_names.${item.id.split('/')[1]}` : item.kind === 'analysis' ? `analyses.${item.slug}.name` : null
    return key && tSkills.has(key) ? tSkills(key) : item.kind === 'knowledge' ? item.id.split('/')[1] : item.slug
  }))].join(', ')

  // Source/kicker line for a row and the detail panel: the proposal's own
  // number (which one it is), operation type, origin (when an agent staged
  // it) and relative age.
  const sourceLine = (op: PendingOperation) =>
    [
      proposalNumberLabel(op, t),
      operationLabel(op.operation_type, t, op.params),
      stagerOf(op),
      op.agent_metadata?.skills_loaded?.length ? t('skills_retrieved', { skills: retrievedNames(op.agent_metadata.skills_loaded) }) : null,
      formatRelativeTime(op.created_at, t),
    ]
      .filter(Boolean)
      .join(' · ')

  const detailOp = detailOpId
    ? filteredOperations.find((op) => op.id === detailOpId) ?? null
    : null
  const detailPeriod = detailOp ? getPeriodStatus(detailOp) : null
  const detailPeriodLocked = detailPeriod != null && detailPeriod.status !== 'open'
  const detailConversationId = detailOp?.agent_metadata?.conversation_id ?? null
  // The open daily batch's own review dialog (the same props for each).
  const BatchReviewDialog = batchReview ? DAILY_BATCH_DIALOG[batchReview.type] : null

  // What the review template needs of a proposal, in this page's words: who
  // staged it, the instructions the agent retrieved, and what its primary
  // does. The approval is the drawer's own: a daily batch opens its review
  // dialog, high risk its confirmation, the rest are approved on the click.
  const retrievedOf = (op: PendingOperation) =>
    op.agent_metadata?.skills_loaded?.length ? retrievedNames(op.agent_metadata.skills_loaded) : null
  const consequenceOf = (op: PendingOperation | null) =>
    op && op.status === 'pending' ? singleActionWarning(op.operation_type, op.params, t, op.preview_data) : ''
  // The proposals that wait and are on screen (one on its way to the server
  // is not among them), and the ones whose last approval did not go through.
  const waitingIds = new Set(filteredOperations.filter((op) => op.status === 'pending').map((op) => op.id))
  const refusedIds = failedIds(approvalResults, waitingIds)
  // A refusal is the server's sentence after "Nekades"; a request that got
  // no answer was not refused, and says only that it did not get there.
  const failureText = (failure: ApprovalFailure) =>
    failure.kind === 'network' ? failure.message : t('refused_row', { message: failure.message })
  const queueMarks = new Map(
    [...refusedIds].map((id) => [id, t(approvalResults[id].kind === 'network' ? 'refused_marker_network' : 'refused_marker')]),
  )
  /** A failed approval as the bar and the drawer footer state it: the sentence, and where to fix it when the refusal names a place. */
  const failureNoteOf = (op: PendingOperation | null) => {
    const failure = failureOf(approvalResults, op?.id, waitingIds)
    if (!op || !failure) return null
    const fixHref = failure.fixCode ? fixableRefusalFor(op.operation_type, failure.fixCode)?.fixHref : undefined
    const copy = failure.fixCode ? FIXABLE_REFUSAL_COPY[failure.fixCode] : undefined
    return {
      message: failureText(failure),
      action:
        fixHref && copy ? (
          <Link href={fixHref} className="underline underline-offset-2">
            {t(copy.link)}
          </Link>
        ) : undefined,
    }
  }
  const reviewPrimaryOf = (op: PendingOperation): ReviewPrimary => {
    const batchType = dailyBatchTypeOf(op.operation_type)
    const period = getPeriodStatus(op)
    const locked = period != null && period.status !== 'open'
    return {
      // After a request that got no answer, the same approval is a retry.
      label: batchType
        ? t(DAILY_BATCH_REVIEW_LABEL_KEY[batchType])
        : failureOf(approvalResults, op.id, waitingIds)?.kind === 'network'
          ? tCommon('retry')
          : t('approve'),
      disabled: locked || isCommitting,
      title: locked ? t('period_locked_short') : undefined,
      onClick: () => {
        if (batchType) {
          setDetailOpId(null)
          setBatchReview({ id: op.id, type: batchType })
        } else if (op.risk_level === 'high') {
          setSelectedOp(op)
          setShowCommitDialog(true)
        } else {
          void queueApproval(op)
        }
      },
    }
  }
  const detailGate = useReviewGate(detailOp, consequenceOf(detailOp))
  const detailFailure = failureNoteOf(detailOp)

  // The walk (/pending/[id]): the queue is the list's own order, run by run.
  const reviewQueueKey = reviewMode ? filteredOperations.map((op) => op.id).join(',') : ''
  const reviewOp = reviewMode && reviewId ? filteredOperations.find((op) => op.id === reviewId) ?? null : null
  const reviewPosition = stepPosition(reviewQueueKey ? reviewQueueKey.split(',') : [], reviewOp?.id ?? null)
  const reviewPeriod = reviewOp ? getPeriodStatus(reviewOp) : null
  const reviewGate = useReviewGate(reviewOp, consequenceOf(reviewOp))
  // A locked or closed period stops the approval: the bar says so in place of
  // the consequence sentence, which would promise a booking that cannot happen.
  const reviewLocked = reviewPeriod != null && reviewPeriod.status !== 'open'
  const detailLocked = detailPeriodLocked && detailOp?.status === 'pending'
  const reviewConversationId = reviewOp?.agent_metadata?.conversation_id ?? null
  // The proposal on screen left the queue (approved, rejected, handled
  // elsewhere): on to the next one that is still waiting. A proposal linked
  // to but not loaded yet is looked for in the older pages first.
  useEffect(() => {
    if (!reviewMode || !reviewId || isLoading || loadError === 'initial') return
    const ids = reviewQueueKey ? reviewQueueKey.split(',') : []
    if (ids.includes(reviewId)) {
      reviewOrderRef.current = ids
      return
    }
    if (reviewOrderRef.current.includes(reviewId)) {
      setReviewId(stepAfterLeaving(reviewOrderRef.current, reviewId, new Set(ids)))
    } else if (hasMore) {
      if (!isLoadingMore) {
        setIsLoadingMore(true)
        setListWindow((current) => ({ viewKey, size: (current.viewKey === viewKey ? current.size : LIST_PAGE_SIZE) + LIST_PAGE_SIZE }))
      }
    } else if (approvingIds.size === 0) {
      setReviewGone(true)
    }
  }, [reviewMode, reviewId, reviewQueueKey, isLoading, loadError, hasMore, isLoadingMore, viewKey, approvingIds])

  // Proposals still waiting: the server's count less the approvals on their way.
  const waitingCount = Math.max(0, (pendingCount ?? 0) - approvingIds.size)
  const sourceFilters: Record<SourceFilter, string> = { all: t('tab_all'), agent: t('tab_agent'), high_risk: t('tab_high_risk') }

  return (
    <AccountNamesContext.Provider value={accountNames}>
    <div className="space-y-8">
      {reviewMode ? (
        <>
          <PageHeader title={t('review_title')} parent={{ label: t('title_rutin'), href: '/pending' }} />
          {isLoading || (reviewId && !reviewOp && !reviewGone && loadError !== 'initial') ? (
            <ReviewWalkLoading />
          ) : loadError === 'initial' ? (
            <LoadError title={t('load_failed_title')} onRetry={() => void fetchOperations()} />
          ) : (
            <ReviewWalk
              groups={runs.map((run) => ({ key: run.key, label: runLabel(run.ops[0]), ops: run.ops }))}
              op={reviewOp}
              // "N av M" counts every proposal that waits, not only the page
              // of the queue that is loaded (the place is the same in both).
              position={
                sourceFilter === 'all' && !conversationFilter
                  ? { ...reviewPosition, count: Math.max(reviewPosition.count, waitingCount) }
                  : reviewPosition
              }
              kicker={reviewOp ? sourceLine(reviewOp) : ''}
              origin={reviewOp ? originOf(reviewOp) : null}
              retrieved={reviewOp ? retrievedOf(reviewOp) : null}
              banner={
                reviewPeriod && reviewPeriod.status !== 'open' ? <PeriodLockBanner period={reviewPeriod} /> : undefined
              }
              historyTrailing={
                reviewConversationId ? (
                  <Link href={`/pending?conversation=${reviewConversationId}`} className={QUIET_LINK_CLASS}>
                    {t('show_conversation')}
                  </Link>
                ) : undefined
              }
              note={reviewLocked ? t('period_locked_short') : reviewGate.note}
              failure={reviewLocked || reviewGate.blocked ? null : failureNoteOf(reviewOp)}
              queueMarks={queueMarks}
              blocked={reviewGate.blocked || reviewLocked}
              primary={reviewOp ? reviewPrimaryOf(reviewOp) : null}
              onReject={() => reviewOp && openRejectDialog(reviewOp)}
              rejectDisabled={isRejecting}
              onStep={setReviewId}
              remaining={filteredOperations.length}
              gone={reviewGone}
            />
          )}
        </>
      ) : (
        <>
      {/* The top bar: Rutin and its one primary. From the list it leads to the
          spot check (when there are more proposals than the sample holds);
          in the spot check it approves all, once the person has looked. */}
      {spotCheckOpen ? (
        <PageHeader
          title={t('spot_title')}
          parent={{ label: t('title_rutin'), href: '/pending' }}
          action={
            <Button size="toolbar" disabled={!canWrite || !spotChecked || isBulkCommitting || isRejecting} title={lockedTitle} onClick={openApproveAll}>
              {t('approve_all_count', { count: bulkEligible.length })}
            </Button>
          }
        />
      ) : (
        <PageHeader
          title={t('title_rutin')}
          action={
            activeTab === 'pending' && filteredOperations.length > 0 ? (
              <span className="flex items-center gap-2">
                {/* The walk through the queue, one proposal on the review template at a time. */}
                <Button size="toolbar" variant="outline" asChild>
                  <Link href={`/pending/${filteredOperations[0].id}`}>{t('review_one_by_one')}</Link>
                </Button>
                {bulkEligible.length > 0 && (
                  <Button
                    size="toolbar"
                    disabled={!canWrite || isBulkCommitting || isRejecting}
                    title={lockedTitle}
                    onClick={() => {
                      if (bulkEligible.length > SPOT_CHECK_SIZE) setSpotCheck(true)
                      else openApproveAll()
                    }}
                  >
                    {t('approve_proposals', { count: bulkEligible.length })}
                  </Button>
                )}
              </span>
            ) : undefined
          }
        />
      )}

      {spotCheckOpen && (
        <section className="stagger-enter" aria-label={t('spot_title')}>
          <h2 className="text-xl text-strong">
            {t('spot_headline', { sample: spotSample.length, count: bulkEligible.length })}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {eligibleBreakdown.map(([type, count]) => bulkActionLabel(type, count, t)).join(' ')}
          </p>
          <div className={cn(LIST_BLEED_CLASS, 'mt-4 border-t-hairline')}>
            {spotSample.map(({ op, reason }) => {
              const warning = complianceWarningOf(op)
              return (
                <div key={op.id} className="border-b-hairline px-2 py-3">
                  <div className="flex min-w-0 items-baseline gap-3">
                    {/* data-ph-mask: the title carries counterparty and amount. */}
                    <p className="min-w-0 flex-1 break-words text-[13px] font-medium text-strong" data-ph-mask="">
                      {pendingDailyBatchTypeOf(op) ? dailyBatchRow(pendingDailyBatchTypeOf(op)!, op).title : op.title}
                    </p>
                    {!pendingDailyBatchTypeOf(op) && <ReviewRisk op={op} quiet />}
                    <RowAmount op={op} />
                  </div>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {t(SPOT_CHECK_REASON_KEY[reason])} · {sourceLine(op)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="min-w-0 flex-1 basis-64 break-words text-[13px]" data-ph-mask="">
                      {warning ? complianceWarningText(warning) : (op.agent_reason ?? '')}
                    </p>
                    <span className="-mr-2 flex shrink-0 items-center gap-1">
                      {/* The full-page review; a daily batch keeps its own dialog. */}
                      {pendingDailyBatchTypeOf(op) ? (
                        <Button variant="ghost" onClick={() => openReview(op)}>
                          {tCommon('open')}
                        </Button>
                      ) : (
                        <Button variant="ghost" asChild>
                          <Link href={`/pending/${op.id}`}>{tCommon('open')}</Link>
                        </Button>
                      )}
                      <Button variant="ghost" disabled={!canWrite || isRejecting} title={lockedTitle} onClick={() => openRejectDialog(op)}>
                        {t('spot_looks_wrong')}
                      </Button>
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('spot_note', { sample: spotSample.length })}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={spotChecked} onClick={() => setSpotChecked(true)}>
              {t('spot_confirm', { sample: spotSample.length })}
            </Button>
            <Button variant="ghost" onClick={() => setSpotCheck(false)}>
              {t('spot_back')}
            </Button>
          </div>
        </section>
      )}

      {!spotCheckOpen && activeTab === 'pending' && !isLoading && loadError !== 'initial' && waitingCount > 0 && (
        <div>
          <h2 className="text-xl text-strong">{t('rutin_headline', { count: waitingCount })}</h2>
          {/* Why the top bar's number is lower than the headline's. */}
          {bulkEligible.length > 0 && excludedFromBulk > 0 && (
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t('rutin_bulk_split', { together: bulkEligible.length, apart: excludedFromBulk })}
            </p>
          )}
        </div>
      )}

      {!spotCheckOpen && conversationFilter && (
        <div className="flex items-center justify-between rounded-lg px-3 py-2 text-sm bg-control shadow-raised">
          <div className="flex items-center gap-2">
            <ChatBubbleLeftIcon className="h-4 w-4 text-muted-foreground" />
            <span>
              {t('conversation_filter_label')}{' '}
              <span className="font-mono">#{conversationFilter.slice(0, 8)}</span>
            </span>
          </div>
          <Button
            variant="ghost"
            onClick={() => {
              setConversationFilter(null)
              if (typeof window !== 'undefined') {
                const url = new URL(window.location.href)
                url.searchParams.delete('conversation')
                window.history.replaceState({}, '', url.toString())
              }
            }}
          >
            {t('conversation_filter_clear')}
          </Button>
        </div>
      )}

      {/* Toolbar (concept): status seg left, source picker (convention 8)
          far right. The count chip rides only on Väntar: it is the queue. */}
      <div className={cn('flex flex-wrap items-center gap-2', spotCheckOpen && 'hidden')}>
        <SegmentedControl
          value={activeTab}
          onChange={setActiveTab}
          options={[
            // The headline states the number while Väntar is open; the tab
            // carries it only from Historik, where the headline is not shown.
            { value: 'pending', label: t('tab_pending'), ...(activeTab === 'pending' ? {} : { count: waitingCount }) },
            { value: 'history', label: t('tab_history') },
          ]}
        />
        {activeTab === 'pending' && (
          <Button
            size="toolbar"
            variant="ghost"
            className="gap-1.5 text-muted-foreground"
            onClick={toggleSortOrder}
            aria-pressed={sortOrder === 'asc'}
            title={sortOrder === 'asc' ? t('sort_oldest_first') : t('sort_newest_first')}
          >
            <ArrowsUpDownIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {sortOrder === 'asc' ? t('sort_oldest_first') : t('sort_newest_first')}
          </Button>
        )}
        {/* Quiet cue that a background reconcile is running (post-action or
            realtime): the list itself never swaps to a spinner for it. */}
        {(isRefreshing || approvingIds.size > 0) && !isLoading && (
          <SpinnerIcon
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-label={approvingIds.size > 0 ? t('approving_count', { count: approvingIds.size }) : t('refreshing')}
          />
        )}
        <div className="ml-auto">
          <ContextPicker
            value={sourceFilter}
            onChange={(id) => setSourceFilter(id as SourceFilter)}
            triggerLabel={sourceFilters[sourceFilter]}
            items={Object.entries(sourceFilters).map(([id, label]) => ({ id, label }))}
          />
        </div>
      </div>

      <div className={cn(spotCheckOpen && 'hidden')}>
        {/* Bulkbar (concept): hidden until at least one operation is selected
            via the hover checkboxes, then it pops in with the count, the batch
            actions, and the selection shortcuts as quiet links. */}
        {showBulkControls && (
          <BulkSelectionBar
            selection={selection}
            selectableCount={bulkEligible.length}
            countLabel={t('bulkbar_selected', { count: selectedCount })}
            selectAllLabel={t('select_all_count', { count: bulkEligible.length })}
            clearLabel={t('deselect')}
          >
            <Button
              disabled={!canWrite || isBulkCommitting || isRejecting}
              title={lockedTitle}
              onClick={() => {
                setGroupAcknowledged(false)
                setShowBulkDialog(true)
              }}
            >
              {t('approve_count', { count: selectedCount })}
            </Button>
            <Button
              variant="outline"
              disabled={!canWrite || isRejecting || isBulkCommitting}
              title={lockedTitle}
              onClick={() => openRejectDialog('bulk')}
            >
              {t('reject_count', { count: selectedCount })}
            </Button>
            {/* One menu for the per-type picks and the note on what a bulk
                cannot take, so the bar stays one short row at any count of types. */}
            {(typeCounts.length >= 2 || excludedFromBulk > 0) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className={QUIET_LINK_CLASS}>
                    {t('select_by_type')}
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top">
                  {typeCounts.length >= 2 &&
                    typeCounts.map(([type, count]) => (
                      <DropdownMenuItem key={type} onSelect={() => selectAllOfType(type)}>
                        {bulkActionKeyLabel(type, t)} ({count})
                      </DropdownMenuItem>
                    ))}
                  {excludedFromBulk > 0 && (
                    <DropdownMenuLabel className="font-normal text-muted-foreground">
                      {t('bulk_excluded_note', { count: excludedFromBulk })}
                    </DropdownMenuLabel>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </BulkSelectionBar>
        )}

        {loadError === 'refresh' && !isLoading && (
          <AttnLine className="mb-3" action={{ label: tCommon('retry'), onClick: () => void fetchOperations() }}>
            {tCommon('refresh_failed')}
          </AttnLine>
        )}

        {isLoading ? (
          <LateReveal>
            <DataListLoading />
          </LateReveal>
        ) : loadError === 'initial' ? (
          <LoadError title={t('load_failed_title')} onRetry={() => void fetchOperations()} />
        ) : filteredOperations.length === 0 ? (
          activeTab === 'pending' ? (
            /* Concept empty state: the queue is the good news. */
            <EmptyState
              tone="done"
              icon={CheckIcon}
              title={t('empty_pending_title')}
              description={t('empty_pending_description')}
            />
          ) : (
            <DataListEmpty
              icon={<ClipboardDocumentCheckIcon className="h-6 w-6" />}
              title={t('empty_history_title')}
              description={t('empty_finished_description')}
            />
          )
        ) : (
          <div className="stagger-enter">
            {filteredOperations.map((op) => {
              const period = getPeriodStatus(op)
              const periodLocked = period != null && period.status !== 'open'
              // The same stop as the review's Godkänn: a required field is missing.
              const rowMissing = missingFields(op).map((label) => factLabelText(label, t))
              const canBulkSelect = showBulkControls && isBulkSelectable(op)
              const isSelected = selectedIds.has(op.id)
              const batchType = dailyBatchTypeOf(op.operation_type)
              // A daily batch (the collections run, the reminders) is the
              // company's own morning run, not an agent proposal: no agent
              // mark, no risk chip, its own words
              // (lib/pending-operations/daily-batches).
              const runType = pendingDailyBatchTypeOf(op)
              const isRun = runType !== null
              const runRow = runType ? dailyBatchRow(runType, op) : null
              // High risk, and a registration of an already-booked invoice
              // (it cannot be undone): the consent sentence the approval
              // confirms in a dialog.
              const rowConsent = rowConsentSentence(op, t)
              const complianceWarning = complianceWarningOf(op)

              if (op.status !== 'pending') {
                // Historik row (concept k-row): status chip + text + sub line.
                const resolvedAt = op.resolved_at ?? op.created_at
                const sub = [
                  proposalNumberLabel(op, t),
                  formatRelativeTime(resolvedAt, t),
                  operationLabel(op.operation_type, t, op.params),
                  originLabel(op, t, attribute),
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <div
                    key={op.id}
                    role="button"
                    tabIndex={0}
                    aria-label={op.title}
                    onClick={() => setDetailOpId(op.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setDetailOpId(op.id)
                      }
                    }}
                    className={cn(
                      'group flex cursor-pointer items-start gap-3 border-b-hairline px-1 py-3 transition-colors duration-150',
                      detailOpId === op.id ? 'bg-secondary/25' : 'hover:bg-secondary/35',
                    )}
                  >
                    {/* Chips mark exceptions: an approved operation is the
                        normal outcome and reads as muted text. */}
                    {op.status === 'committed' && signingUrlOf(op.result_data) ? (
                      // Approved but locked at Skatteverket until signed (crm#1478).
                      <Badge variant="warning" className="mt-0.5 shrink-0 font-normal">{tSigning('sent_badge')}</Badge>
                    ) : op.status === 'committed' && !isAutoExpired(op) ? (
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{t('badge_approved')}</span>
                    ) : isHandledElsewhere(op) ? (
                      // Closed by the system, nobody's verdict: muted text like the normal outcome.
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{t('badge_handled_elsewhere')}</span>
                    ) : (
                      <Badge
                        variant={
                          isAutoExpired(op)
                            ? 'secondary'
                            : op.status === 'failed_partial' || op.status === 'unknown'
                              ? 'warning'
                              : 'destructive'
                        }
                        className="mt-0.5 shrink-0 font-normal"
                      >
                        {isAutoExpired(op)
                          ? t('badge_auto_expired')
                          : op.status === 'failed_partial'
                            ? t('badge_failed_partial')
                            : op.status === 'unknown'
                              ? t('badge_unknown')
                              : op.rejection_category === 'failed'
                                ? t('badge_closed_by_refusal')
                                : t('badge_rejected')}
                      </Badge>
                    )}
                    <div className="min-w-0 flex-1">
                      {/* break-words: titles carry file names with no space to
                          wrap at, which ran out of the row (crm#1003). */}
                      <div className="break-words text-[13px] leading-snug">{op.title}</div>
                      <div className="mt-0.5 break-words text-xs text-muted-foreground">
                        {sub}
                        {op.status === 'rejected' && op.rejection_reason
                          ? ` · ${t('history_reason', { reason: op.rejection_reason })}`
                          : ''}
                      </div>
                      {op.status === 'failed_partial' && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t('failed_partial_detail')}
                          {failedPartialPostedIds(op) && (
                            <span className="font-mono"> ({failedPartialPostedIds(op)})</span>
                          )}
                        </p>
                      )}
                      {op.status === 'unknown' && (
                        <p className="mt-1 text-xs text-muted-foreground">{t('unknown_detail')}</p>
                      )}
                      {/* Closed by a refused approval, nobody's verdict: why,
                          in words for a person. data-ph-mask: may name a
                          counterparty or an invoice. */}
                      {closedByRefusalReason(op) && (
                        <p className="mt-1 break-words text-xs text-muted-foreground" data-ph-mask="">
                          {t('closed_by_refusal_detail', { reason: closedByRefusalReason(op) ?? '' })}
                        </p>
                      )}
                    </div>
                    <ChevronRightIcon
                      className={cn(
                        'mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-opacity',
                        detailOpId === op.id ? 'opacity-100' : HOVER_REVEAL_CLASS,
                      )}
                    />
                  </div>
                )
              }

              // One line per operation (convention 4): who staged it, the
              // title, its age, a risk chip only when it deviates, and the
              // two decisions as hover-revealed icon buttons; under the title,
              // the agent's reason as one muted line when it gave one. The
              // kicker (type, origin, retrieved instructions) and the consent
              // sentence live in the slide-over the row opens.
              const approveLabel = batchType ? t(DAILY_BATCH_REVIEW_LABEL_KEY[batchType]) : t('approve')
              const approveLockedReason =
                lockedTitle ??
                (periodLocked
                  ? t('period_locked_short')
                  : rowMissing.length > 0
                    ? t('review_missing_named', { fields: rowMissing.join(', ') })
                    : undefined)
              const approveDisabled = !canWrite || periodLocked || rowMissing.length > 0 || isBulkCommitting
              const rowTitle = splitRowTitle(op.title)
              const fixCopy = FIXABLE_REFUSAL_COPY[fixNotes[op.id]]
              // A locked or closed period disables Godkänn on the row, so the
              // line says why before anything else staged with it (crm#1923).
              const rowLine: { text: string; attention: boolean; refused?: boolean; fixHref?: string; fixLabel?: string } | null = fixCopy
                ? {
                    text: t(fixCopy.note),
                    attention: true,
                    fixHref: fixableRefusalFor(op.operation_type, fixNotes[op.id])?.fixHref,
                    fixLabel: t(fixCopy.link),
                  }
                : refusedIds.has(op.id)
                  ? { text: failureText(approvalResults[op.id]), attention: true, refused: true }
                  : periodLocked && period
                    ? { text: periodLockRowText(period, t), attention: true }
                    : isRun
                      ? null
                      : complianceWarning
                        ? { text: complianceWarningText(complianceWarning), attention: true }
                        : op.agent_reason
                          ? { text: op.agent_reason, attention: false }
                          : null
              // The first proposal of a run carries the run's band: who
              // staged them, which day, and how many.
              const run = runStarts.get(op.id)
              return (
                <Fragment key={op.id}>
                {run && (
                  // The band: who proposed, which day, how many, each once.
                  <p className="flex items-end border-b-hairline px-1 pb-1.5 pt-5 text-xs text-muted-foreground first:pt-0" title={runLabel(op)}>
                    <span className="min-w-0 truncate font-medium" data-ph-mask="">
                      {runWho(op)}
                    </span>
                    <span className="date-figures shrink-0 whitespace-pre">
                      {[stagedDay(op) ? formatDate(stagedDay(op)) : null, t('run_count', { count: run.ops.length })]
                        .filter(Boolean)
                        .map((part) => ` · ${part}`)
                        .join('')}
                    </span>
                  </p>
                )}
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={op.title}
                  onClick={() => openReview(op)}
                  onKeyDown={(e) => {
                    // Only the row itself: Enter or Space on the checkbox or
                    // an icon button inside it is that control's own.
                    if (e.target !== e.currentTarget) return
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      openReview(op)
                    }
                  }}
                  className={cn(
                    'group flex min-h-11 cursor-pointer items-center gap-3 border-b-hairline px-1 py-2 transition-colors duration-150',
                    detailOpId === op.id ? 'bg-secondary/25' : 'hover:bg-secondary/35',
                    isSelected && 'bg-secondary/40',
                  )}
                >
                  {/* Always-visible selection checkbox (concept .cb) */}
                  <span
                    className="flex w-[18px] shrink-0 select-none items-center"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canBulkSelect && (
                      <RowSelectCheckbox
                        checked={isSelected}
                        onClick={(e) => {
                          shiftHeld.current = e.shiftKey
                        }}
                        onCheckedChange={() => selection.toggle(op.id, shiftHeld.current)}
                        aria-label={t('select_operation_aria')}
                      />
                    )}
                  </span>
                  {/* Line 1: what it is. The type ("Kategorisera:") is quiet and
                      gives way first (a phone leaves it out); the part that
                      identifies the item keeps the width. Line 2: ONE line, why it needs a person: a
                      refused approval, else the period lock that stops the
                      approval, else the staged warning (it must not
                      pass unseen, crm#1003), else the agent's reason. The
                      review has each in full; when it was staged is the
                      band's date, and in the hover text. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span
                      className="flex min-w-0 items-baseline gap-1 text-[13px]"
                      title={runRow?.detail ?? `${op.title} · ${formatRelativeTime(op.created_at, t)}`}
                      data-ph-mask=""
                    >
                      {/* Which proposal this is: its own number, the same
                          before and after the ones around it are approved. */}
                      <ProposalNumber op={op} />
                      {!runRow && rowTitle.type && (
                        <span className="min-w-0 shrink-[100] truncate text-muted-foreground max-sm:hidden">{rowTitle.type}</span>
                      )}
                      <span className="min-w-0 truncate text-strong">{runRow?.title ?? rowTitle.name}</span>
                    </span>
                    {rowLine && (
                      <span
                        className={cn('flex min-w-0 items-start gap-1 text-xs', rowLine.attention ? 'text-attn' : 'text-muted-foreground')}
                        {...(rowLine.refused ? { 'data-refused': '' } : {})}
                      >
                        {rowLine.attention && <ExclamationTriangleIcon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
                        {/* line-clamp, not truncate: the cut falls between words. */}
                        <span className="line-clamp-1 min-w-0 break-words" title={rowLine.text} data-ph-mask="">
                          {rowLine.text}
                        </span>
                        {rowLine.fixHref && (
                          <a href={rowLine.fixHref} className="shrink-0 underline underline-offset-2" onClick={(e) => e.stopPropagation()}>
                            {rowLine.fixLabel}
                          </a>
                        )}
                      </span>
                    )}
                  </span>
                  {/* Risk: only high risk is marked, in one fixed place. */}
                  <span className="flex w-[4.5rem] shrink-0 justify-end max-sm:w-auto">{!isRun && <ReviewRisk op={op} quiet />}</span>
                  <RowAmount op={op} />
                  {/* The two decisions, in a fixed place: shown on row hover
                      and keyboard focus with a pointer, always on touch
                      (HOVER_REVEAL_CLASS), so nothing shifts. On a phone the
                      row opens the review, where both sit in the fixed footer. */}
                  <span className={cn('flex shrink-0 items-center justify-end gap-1 max-sm:hidden', HOVER_REVEAL_CLASS)}>
                    {/* What the click books, shown before it on hover and
                        keyboard focus, led by the reason a locked button is
                        locked. A daily batch's button opens its own review
                        dialog: no card, and its reason stays its title. */}
                    <ApprovalHoverPreview
                      op={op}
                      lockedReason={approveLockedReason}
                      disabled={approveDisabled}
                      off={batchType !== null}
                    >
                      <Button
                        variant="row-primary"
                        title={batchType ? approveLockedReason : undefined}
                        disabled={approveDisabled}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (periodLocked || rowMissing.length > 0) return
                          if (batchType) {
                            setBatchReview({ id: op.id, type: batchType })
                          } else if (op.risk_level === 'high' || rowConsent) {
                            // High risk, and an approval that cannot be undone
                            // (a registration of an already-booked invoice),
                            // confirm in the dialog that carries the consent
                            // sentence: the row no longer shows it.
                            setSelectedOp(op)
                            setShowCommitDialog(true)
                          } else {
                            // Low/medium: the row's button is the approval.
                            void queueApproval(op)
                          }
                        }}
                      >
                        {approveLabel}
                      </Button>
                    </ApprovalHoverPreview>
                    <Button
                      variant="row"
                      title={lockedTitle}
                      disabled={!canWrite || isRejecting}
                      onClick={(e) => {
                        e.stopPropagation()
                        openRejectDialog(op)
                      }}
                    >
                      {t('reject')}
                    </Button>
                  </span>
                </div>
                </Fragment>
              )
            })}
          </div>
        )}

        {/* The list is paged: keep the way to older operations reachable
            whenever the server holds more than the loaded window. */}
        {!isLoading && hasMore && (
          <div className="flex justify-center pt-3">
            <Button variant="outline" onClick={loadMore} loading={isLoadingMore}>
              {tCommon('load_more')}
            </Button>
          </div>
        )}
      </div>

        </>
      )}

      {/* Detail slide-over (convention 13): the review surface. Derived from
          the live list, so a realtime refetch that resolves the op closes it. */}
      <SlideOver
        open={detailOp != null}
        onOpenChange={(open) => {
          if (!open) setDetailOpId(null)
        }}
      >
        {/* 640px, the width the Arkiv document review uses: at the 480px
            default the previews' two-column rows squeezed file names and
            texts into a column a word wide (crm#1003). */}
        <SlideOverContent aria-describedby={undefined} className="w-[640px]">
          {detailOp && (
            <>
              <SlideOverHeader kicker={sourceLine(detailOp)} title={detailOp.title} />
              {/* The fixed review template (ProposalReview): the amount, the
                  one attention line, the proposal as typed fields and the
                  verifikat it posts, the underlag as the file, how a resolved
                  proposal ended, and the history behind a disclosure. */}
              <SlideOverBody>
                <ProposalReviewDrawerBody
                  key={detailOp.id}
                  op={detailOp}
                  origin={originOf(detailOp)}
                  retrieved={retrievedOf(detailOp)}
                  banner={
                    detailPeriodLocked && detailPeriod && detailOp.status === 'pending' ? (
                      <PeriodLockBanner period={detailPeriod} />
                    ) : undefined
                  }
                  historyTrailing={
                    detailConversationId ? (
                      <button
                        type="button"
                        className={QUIET_LINK_CLASS}
                        onClick={() => {
                          setConversationFilter(detailConversationId)
                          setDetailOpId(null)
                        }}
                      >
                        {t('show_conversation')}
                      </button>
                    ) : undefined
                  }
                  outcome={
                    detailOp.status === 'pending' ? undefined : (
                      <div className="space-y-2 text-[13px]">
                        {isHandledElsewhere(detailOp) && (
                          <p className="text-muted-foreground">{t('handled_elsewhere_detail')}</p>
                        )}
                        {detailOp.status === 'rejected' && detailOp.rejection_category && detailOp.rejection_category !== 'expired' && !isHandledElsewhere(detailOp) && (
                          <p className="break-words text-muted-foreground" data-ph-mask="">
                            Avvisad: {rejectionCategoryLabel(detailOp.rejection_category)}
                            {detailOp.rejection_reason ? `, "${detailOp.rejection_reason}"` : ''}
                          </p>
                        )}
                        {detailOp.status === 'committed' && signingUrlOf(detailOp.result_data) && (
                          <SigningStep url={signingUrlOf(detailOp.result_data)!} afterwards />
                        )}
                        {isAutoExpired(detailOp) && (
                          <p className="text-muted-foreground">{t('auto_expired_detail')}</p>
                        )}
                        {detailOp.status === 'failed_partial' && (
                          <p className="text-muted-foreground">
                            {t('failed_partial_detail')}
                            {failedPartialPostedIds(detailOp) && (
                              <span className="font-mono"> ({failedPartialPostedIds(detailOp)})</span>
                            )}
                          </p>
                        )}
                        {detailOp.status === 'unknown' && (
                          <p className="text-muted-foreground">{t('unknown_detail')}</p>
                        )}
                      </div>
                    )
                  }
                />
              </SlideOverBody>
              {/* The fixed footer: what the approval does (or which required
                  field is missing), "Ser fel ut" and the one primary. */}
              {detailOp.status === 'pending' && (
                <SlideOverFooter className="flex-wrap">
                  {detailFailure && !detailLocked && !detailGate.blocked ? (
                    <p className="mr-auto min-w-0 flex-1 basis-full break-words text-xs text-attn sm:basis-48" data-ph-mask="">
                      {detailFailure.message} {detailFailure.action}
                    </p>
                  ) : (
                    (detailLocked || detailGate.note) && (
                      <p className={cn('mr-auto min-w-0 flex-1 basis-full text-xs sm:basis-48', detailLocked || detailGate.blocked ? 'text-attn' : 'text-muted-foreground')}>
                        {detailLocked ? t('period_locked_short') : detailGate.note}
                      </p>
                    )
                  )}
                  <ReviewActionButtons
                    primary={reviewPrimaryOf(detailOp)}
                    blocked={detailGate.blocked}
                    onReject={() => openRejectDialog(detailOp)}
                    rejectDisabled={isRejecting}
                  />
                </SlideOverFooter>
              )}
            </>
          )}
        </SlideOverContent>
      </SlideOver>

      {BatchReviewDialog && batchReview && (
        <BatchReviewDialog
          key={batchReview.id}
          operationId={batchReview.id}
          open
          onOpenChange={(open) => {
            if (!open) setBatchReview(null)
          }}
          onCommitted={() => {
            void fetchOperations()
          }}
        />
      )}

      {/* After approving a Skatteverket filing: the declaration is locked
          there and filed only once someone signs with BankID (crm#1478). */}
      <Dialog open={signingPrompt != null} onOpenChange={(open) => { if (!open) setSigningPrompt(null) }}>
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{tSigning('sign_action')}</DialogTitle>
            <DialogDescription data-ph-mask="">{signingPrompt?.title}</DialogDescription>
          </DialogHeader>
          {signingPrompt && <SigningStep url={signingPrompt.url} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSigningPrompt(null)}>{tCommon('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A possible duplicate stopped an approval: the proposal waits while
          the person matches the bank row to the verifikat that is already
          there, books anyway, or leaves it. Matching books the row, and the
          next read of the queue then closes the proposal as handled. */}
      <DuplicateBookingDialog
        candidate={duplicatePrompt?.candidate ?? null}
        subject={duplicatePrompt?.op.title}
        onCancel={closeDuplicatePrompt}
        onBookAnyway={() => {
          if (!duplicatePrompt) return
          closeDuplicatePrompt()
          void queueApproval(duplicatePrompt.op, duplicatePrompt.candidate.journal_entry_id)
        }}
        matchTransaction={duplicatePromptTransactionId ? { id: duplicatePromptTransactionId } : null}
        onMatched={(_transactionId, _journalEntryId, voucherLabel) => {
          closeDuplicatePrompt()
          toast({ title: t('duplicate_matched', { voucher: voucherLabel }) })
          afterResolve()
        }}
      />

      {/* Commit confirmation dialog */}
      <ConfirmationDialog
        open={showCommitDialog}
        onOpenChange={setShowCommitDialog}
        title={selectedOp?.title || t('approve_operation_title')}
        warningText={selectedOp ? singleActionWarning(selectedOp.operation_type, selectedOp.params, t, selectedOp.preview_data) : ''}
        confirmLabel={t('approve')}
        isSubmitting={isCommitting}
        onConfirm={handleCommit}
      >
        {selectedOp && <OperationPreview op={selectedOp} />}
      </ConfirmationDialog>

      {/* An approved verifikat the booking-time guard stopped: the proposal
          waits while the person reads the warnings. "Bokför ändå" sends the
          same approval again with these codes confirmed; the guard runs
          again, and a warning that appeared meanwhile is asked the same way. */}
      <VoucherWarningsDialog
        warnings={voucherConfirm?.warnings ?? null}
        processing={false}
        onCancel={closeVoucherConfirm}
        onConfirm={() => {
          if (!voucherConfirm) return
          const { op, warnings } = voucherConfirm
          closeVoucherConfirm()
          void queueApproval(op, undefined, warnings.map((warning) => warning.code))
        }}
      />

      {/* Bulk commit confirmation dialog */}
      <ConfirmationDialog
        open={showBulkDialog}
        onOpenChange={setShowBulkDialog}
        title={t('approve_bulk_title', { count: bulkConfirmCount })}
        warningText={selectedWarnedCount > 0 ? t('bulk_warning_note', { count: selectedWarnedCount }) : ''}
        confirmLabel={t('approve_count', { count: bulkConfirmCount })}
        confirmDisabled={bulkConfirmCount === 0}
        isSubmitting={isBulkCommitting}
        onConfirm={() => {
          // Without the acknowledgment the routine high-risk rows stay out:
          // the rest of the selection is still approved.
          const groups = groupAcknowledged
            ? [...new Set(selectedGroupOps.map(sharedAcknowledgmentGroup).filter((g): g is SharedAcknowledgmentGroup => g != null))]
            : []
          const groupIds = new Set(selectedGroupOps.map((op) => op.id))
          // Oldest staged first across the request-sized chunks too, whatever
          // the list is sorted by (crm#1815).
          const ids = oldestStagedFirst(
            Array.from(selectedIds).filter((id) => groupAcknowledged || !groupIds.has(id)),
            new Map(bulkEligible.map((op) => [op.id, op])),
          )
          void handleBulkCommit(ids, groups)
        }}
      >
        <div className="space-y-3 text-sm">
          <p>{t('bulk_confirm_intro')}</p>
          {selectedBreakdown.length > 0 && (
            <ul className="border-t-hairline">
              {selectedBreakdown.map(([type, count]) => (
                <li key={type} className="border-b-hairline py-2 text-[13px]">
                  <span className="break-words">{bulkActionLabel(type, count, t)}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Routine high-risk rows (crm#1489): one acknowledgment for the
              whole group, stating what it posts, instead of one per row. */}
          {selectedGroupOps.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-strong">
                {t(SHARED_ACK_LABEL_KEYS[groupKind].title, { count: groupSummary.count })}
              </p>
              <p className="text-xs text-muted-foreground">{t('shared_ack_body')}</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs tabular-nums">
                {groupSummary.date_from && (
                  <>
                    <dt className="text-muted-foreground">{t('shared_ack_dates_label')}</dt>
                    <dd>
                      {groupSummary.date_from === groupSummary.date_to
                        ? groupSummary.date_from
                        : t('shared_ack_dates', { from: groupSummary.date_from, to: groupSummary.date_to ?? '' })}
                    </dd>
                  </>
                )}
                {groupSummary.incoming > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t(SHARED_ACK_LABEL_KEYS[groupKind].incoming)}</dt>
                    <dd>{formatCurrency(groupSummary.incoming)}</dd>
                  </>
                )}
                {groupSummary.outgoing > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t(SHARED_ACK_LABEL_KEYS[groupKind].outgoing)}</dt>
                    <dd>{formatCurrency(groupSummary.outgoing)}</dd>
                  </>
                )}
              </dl>
              {groupSummary.accounts.length > 0 && (
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="text-xs text-muted-foreground">
                      <th className="py-1 text-left font-normal">{t('shared_ack_account')}</th>
                      <th className="py-1 text-right font-normal">{t('shared_ack_debit')}</th>
                      <th className="py-1 text-right font-normal">{t('shared_ack_credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groupSummary.accounts.map((account) => (
                      <tr key={account.account_number}>
                        <td className="py-1">
                          <span className="font-mono">{account.account_number}</span>
                          {account.account_name ? ` ${account.account_name}` : ''}
                        </td>
                        <td className="py-1 text-right font-mono">{account.debit > 0 ? formatAmount(account.debit) : ''}</td>
                        <td className="py-1 text-right font-mono">{account.credit > 0 ? formatAmount(account.credit) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <label className="flex cursor-pointer items-start gap-2 pt-1">
                <Checkbox
                  checked={groupAcknowledged}
                  onCheckedChange={(checked) => setGroupAcknowledged(checked === true)}
                  className="mt-0.5"
                />
                <span>{t('shared_ack_confirm', { count: groupSummary.count })}</span>
              </label>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t('bulk_confirm_footer')}
          </p>
        </div>
      </ConfirmationDialog>

      <RejectDialog
        target={rejectTarget}
        selectedCount={selectedCount}
        busy={isRejecting}
        onClose={() => setRejectTarget(null)}
        onReject={handleReject}
      />

      {/* What a bulk approval left undone, one line per operation with the
          reason (crm#1488): the footer of the confirmation promises it. */}
      <Dialog open={bulkOutcome != null} onOpenChange={(open) => { if (!open) setBulkOutcome(null) }}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('bulk_outcome_title')}</DialogTitle>
            <DialogDescription>{bulkOutcome?.summary}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto text-[13px]">
            {bulkOutcome?.items.map((item) => (
              <li key={item.id} className="border-b-hairline pb-2 last:border-b-0">
                <p data-ph-mask="" className="break-words">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.reason ?? t('bulk_outcome_no_reason')}</p>
              </li>
            ))}
          </ul>
          {bulkOutcome?.draftsHint && (
            <p className="text-xs text-muted-foreground">{t('bulk_invoice_drafts_hint')}</p>
          )}
          <DialogFooter>
            <Button onClick={() => setBulkOutcome(null)}>{tCommon('close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AccountNamesContext.Provider>
  )
}

type RejectFeedback = { rejection_category: PendingOperationRejectionCategory; rejection_reason?: string }

/**
 * The reject dialog: a required category plus an optional free-text reason,
 * so every rejection a person makes says what was wrong. Doubles as the
 * bulk-reject confirmation; the feedback then applies to every selected op.
 * The fields are its own state, so typing the reason redraws the dialog and
 * not the list behind it; they start empty each time it opens.
 */
function RejectDialog({
  target,
  selectedCount,
  busy,
  onClose,
  onReject,
}: {
  target: PendingOperation | 'bulk' | null
  selectedCount: number
  busy: boolean
  onClose: () => void
  onReject: (feedback: RejectFeedback) => void
}) {
  const t = useTranslations('pending')
  const tCommon = useTranslations('common')
  const [category, setCategory] = useState<PendingOperationRejectionCategory | ''>('')
  const [reason, setReason] = useState('')
  const [shownTarget, setShownTarget] = useState(target)
  if (target !== shownTarget) {
    setShownTarget(target)
    if (target) {
      setCategory('')
      setReason('')
    }
  }
  return (
    <Dialog open={target != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent size="confirm">
        <DialogHeader>
          <DialogTitle>{target === 'bulk' ? t('reject_bulk_title', { count: selectedCount }) : t('reject_title')}</DialogTitle>
          {/* data-ph-mask: the operation title carries counterparty and amount */}
          <DialogDescription data-ph-mask="">{target === 'bulk' ? t('reject_bulk_description') : target?.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="reject-category">
              {t('reject_category_label')}
            </label>
            <Select value={category} onValueChange={(v) => setCategory(v as PendingOperationRejectionCategory)}>
              <SelectTrigger id="reject-category">
                <SelectValue placeholder={t('reject_category_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REJECTION_CATEGORY_LABELS) as PendingOperationRejectionCategory[]).map((cat) => (
                  <SelectItem key={cat} value={cat}>{REJECTION_CATEGORY_LABELS[cat]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" htmlFor="reject-reason">
              {t('reject_note_label')}
            </label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reject_note_placeholder')}
              rows={3}
              maxLength={2000}
            />
            <p className="text-xs text-muted-foreground">{t('reject_note_help')}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={!category}
            onClick={() => category && onReject({ rejection_category: category, ...(reason.trim() ? { rejection_reason: reason.trim() } : {}) })}
          >
            {target === 'bulk' ? t('reject_count', { count: selectedCount }) : t('reject')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
