'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ComponentProps, type ComponentType } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { Checkbox } from '@/components/ui/checkbox'
import { DataListEmpty, DataListLoading } from '@/components/ui/data-list'
import { ContextPicker } from '@/components/common/ContextPicker'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { CHECKBOX_REVEAL_CLASS, HOVER_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
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
import { collectPages } from '@/lib/lists/collect-pages'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import {
  ArrowsUpDownIcon,
  BellAlertIcon,
  ChatBubbleLeftIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardDocumentCheckIcon,
  CpuChipIcon,
  ExclamationTriangleIcon,
  LockClosedIcon,
  ScaleIcon,
  SpinnerIcon,
  XMarkIcon,
  type Icon,
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
import { describeRetrievedSkills } from '@/lib/agent-skills/retrieved-skills'
import {
  chunkIds,
  sharedAcknowledgmentGroup,
  summarizeSharedAcknowledgment,
  type SharedAcknowledgmentGroup,
} from '@/lib/pending-operations/shared-acknowledgment'
import { registerBookedLedgerOf } from '@/lib/invoices/register-booked-invoice-mode'
import { HandoverBatchDialog } from '@/components/collections/HandoverBatchDialog'
import { COLLECTIONS_BATCH_TYPE } from '@/lib/collections/batch'
import { BATCH_REVIEW_QUERY, batchRowKey, runItems, wantsBatchReview } from '@/lib/collections/batch-dialog'
import { capitalizeFirst } from '@/components/collections/collections-client'
import { ReminderBatchDialog } from '@/components/reminders/ReminderBatchDialog'
import { REMINDER_BATCH_TYPE } from '@/lib/reminders/batch'
import { reminderRunItems, wantsReminderBatchReview } from '@/lib/reminders/batch-dialog'
import { dailyBatchTypeOf, pendingDailyBatchTypeOf, type DailyBatchType } from '@/lib/pending-operations/daily-batches'

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

function bulkActionKey(op: PendingOperation): string {
  const ledger = registerBookedLedgerOf(op.operation_type, op.params)
  return ledger ? REGISTER_BOOKED_BULK_KEYS[ledger] : op.operation_type
}

/** The label of a bulkActionKey: a registration's key names its label (type_<key>). */
function bulkActionKeyLabel(key: string, t: (key: string) => string): string {
  return (Object.values(REGISTER_BOOKED_BULK_KEYS) as string[]).includes(key) ? t(`type_${key}`) : operationLabel(key, t)
}

function bulkActionLabel(operationType: string, count: number, t: (key: string) => string): string {
  const fn = bulkActionDescriptions[operationType]
  if (fn) return fn(count)
  return `${count} × ${operationLabel(operationType, t)}`
}

// The daily batches (lib/pending-operations/daily-batches) on a pending row:
// the mark beside it and what its approve button says (it opens the batch's
// review dialog, it does not approve).
const DAILY_BATCH_ICON: Record<DailyBatchType, Icon> = {
  collections_daily_batch: ScaleIcon,
  reminder_daily_batch: BellAlertIcon,
}
const DAILY_BATCH_REVIEW_LABEL_KEY: Record<DailyBatchType, string> = {
  collections_daily_batch: 'review_collections_batch',
  reminder_daily_batch: 'review_reminder_batch',
}
const DAILY_BATCH_DIALOG: Record<DailyBatchType, ComponentType<ComponentProps<typeof ReminderBatchDialog>>> = {
  collections_daily_batch: HandoverBatchDialog,
  reminder_daily_batch: ReminderBatchDialog,
}

// Period status carried inside preview_data when stagePendingOperation can
// resolve it. Shape mirrors PeriodStatusForDate in lib/core/bookkeeping/period-service.ts.
interface PeriodStatusShape {
  period_id: string | null
  status: 'open' | 'locked' | 'closed'
  lock_date: string | null
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
  }
}

/**
 * Whether an operation may join a bulk approval: pending, in an open period,
 * and not high risk unless it belongs to a group one acknowledgment covers
 * (lib/pending-operations/shared-acknowledgment.ts, crm#1489). The bulk
 * dialog asks for that acknowledgment; without it those rows are left out.
 */
function isBulkSelectable(op: PendingOperation): boolean {
  if (op.status !== 'pending') return false
  if (op.risk_level === 'high' && sharedAcknowledgmentGroup(op) == null) return false
  const period = getPeriodStatus(op)
  return !(period && period.status !== 'open')
}

/** One operation's outcome in a bulk approval (bulk-commit route). */
interface BulkItemResult {
  id: string
  status: 'committed' | 'failed' | 'skipped' | 'rejected'
  error?: string
}

const SORT_ORDER_STORAGE_KEY = 'pending.sortOrder'
// Operations per page of a status stream, and the most the list API returns
// per request (PendingOperationsQuerySchema).
const LIST_PAGE_SIZE = 50
const PENDING_API_MAX_LIMIT = 100

/**
 * Human origin line for a staged operation. Many reviewers never used the AI
 * chat themselves (a colleague or consultant did), so the raw actor_label is
 * not enough context: spell out where the proposal came from.
 */
function originLabel(
  op: PendingOperation,
  t: (key: string, values?: Record<string, string>) => string,
): string | null {
  switch (op.actor_type) {
    case 'agent_chat':
      return t('origin_agent_chat')
    // The claude.ai MCP connector mints a gnubok_sk_ key, so MCP traffic
    // arrives as actor_type='api_key' with the key name as actor_label:
    // keep the label so users with several integrations can tell which one
    // staged the op. 'mcp_oauth' is declared but currently unreachable.
    case 'mcp_oauth':
    case 'api_key':
      return op.actor_label
        ? t('origin_mcp', { label: op.actor_label })
        : t('origin_api')
    case 'service_account':
      return op.actor_label
        ? t('origin_service_account', { label: op.actor_label })
        : t('origin_service_account_plain')
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
 * Rows the expiry cron auto-rejected (app/api/pending-operations/expire/cron).
 * Strict on reason === 'expired' so commit-time auto-rejects (404/409, where
 * reason is the error text) do NOT read as "expired".
 */
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

function isAutoExpired(op: PendingOperation): boolean {
  const rd = op.result_data as { auto_rejected?: boolean; reason?: string } | null
  return op.status === 'rejected' && rd?.auto_rejected === true && rd?.reason === 'expired'
}

function formatRelativeTime(dateStr: string): string {
  const now = new Date()
  const date = new Date(dateStr)
  const diffMs = now.getTime() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)

  if (diffMin < 1) return 'just nu'
  if (diffMin < 60) return `${diffMin} min sedan`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${diffHours} tim sedan`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays} dagar sedan`
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
 * Inline period-lock banner. Renders when the staged operation touches a
 * period that's already locked or closed: the server's commit-time trigger
 * will reject it, so we tell the approver up front rather than letting them
 * click and see a generic "Misslyckades" toast. The fiscal_period_id link
 * goes to the periods management page where unlocking is possible.
 */
function PeriodLockBanner({ period }: { period: PeriodStatusShape }) {
  const lockedThrough = period.lock_date ? formatDate(period.lock_date) : null
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <LockClosedIcon className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="font-medium text-destructive">
          {period.status === 'closed'
            ? 'Perioden är stängd permanent (BFL): kan inte ändras.'
            : `Perioden är låst${lockedThrough ? ` t.o.m. ${lockedThrough}` : ''}.`}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {period.status === 'closed'
            ? 'Använd en omprövning i en öppen period i stället.'
            : 'Lås upp perioden via Bokföring → Räkenskapsperioder, ändra entry-datum, eller avvisa.'}
        </p>
      </div>
    </div>
  )
}

type SourceFilter = 'all' | 'agent' | 'high_risk'

const sourceFilterLabels = (
  t: (key: string) => string,
): Record<SourceFilter, string> => ({
  all: t('tab_all'),
  agent: t('tab_agent'),
  high_risk: t('tab_high_risk'),
})

// Concept scene 11: two views. Historik merges committed + rejected,
// distinguished per row by a status chip.
type ViewTab = 'pending' | 'history'

export default function PendingOperationsPage() {
  const t = useTranslations('pending')
  const tCollections = useTranslations('collections')
  const tReminders = useTranslations('reminders')
  const tSkills = useTranslations('skills_registry')
  const tCommon = useTranslations('common')
  const tSigning = useTranslations('skv_signing')
  const complianceWarningText = useComplianceWarningText()
  const router = useRouter()
  const accountNames = useAccountNamesSource()
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [isLoading, setIsLoading] = useState(true)
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
  // Detail slide-over (convention 13): id rather than the row object, so the
  // panel tracks realtime refetches and closes itself when the op leaves the
  // current list (approved elsewhere, tab switch, filter change).
  const [detailOpId, setDetailOpId] = useState<string | null>(null)
  const [selectedOp, setSelectedOp] = useState<PendingOperation | null>(null)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
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
  const [rejectCategory, setRejectCategory] = useState<PendingOperationRejectionCategory | ''>('')
  const [rejectReason, setRejectReason] = useState('')
  const [isRejecting, setIsRejecting] = useState(false)
  // An approved Skatteverket filing is locked there, not filed: its BankID
  // signing link opens in a dialog right after the approval (crm#1478).
  const [signingPrompt, setSigningPrompt] = useState<{ title: string; url: string } | null>(null)
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
  useEffect(() => {
    hasRowsRef.current = operations.length > 0
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
    } catch {
      if (!isCurrent()) return
      toast({ title: 'Kunde inte ladda operationer', variant: 'destructive' })
      // The rows on screen belong to another tab (or no load has succeeded
      // yet): dropping the loading state here would render those foreign rows
      // under this tab's header as if they were its content. Hold the loading
      // state instead; the toast says why, and the next tab switch or
      // realtime echo retries.
      if (loadedTabRef.current !== activeTab) return
    }
    if (!isCurrent()) return
    setIsLoading(false)
    setIsRefreshing(false)
    setIsLoadingMore(false)
  }, [activeTab, sortOrder, windowSize, toast])

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
          }, 400)
        }
      )
      .subscribe()
    return () => {
      if (debounce) clearTimeout(debounce)
      void supabase.removeChannel(channel)
    }
  }, [companyId, fetchOperations])

  // Resolving operations changes what Att göra counts, and Att göra is a
  // server render the client router keeps (staleTimes.dynamic in
  // next.config.ts, and every back/forward restore): without this the user
  // walked back to the counts from before the approvals and had to hard-reload
  // (crm#1003). router.refresh() drops those cached renders, the contract the
  // 30 s router cache was introduced under for every mutation flow. This list
  // reconciles through fetchOperations; the sidebar badges through realtime.
  function afterResolve() {
    router.refresh()
    fetchOperations()
  }

  // Shared by the direct-commit pill (low/medium risk) and the high-risk
  // confirmation dialog. The Granskning row already states source, title and
  // risk and offers Detaljer, so for low/medium the pill IS the deliberate
  // approval; only high risk keeps the dialog, whose warning sentence carries
  // information the row does not.
  async function commitOp(op: PendingOperation) {
    setIsCommitting(true)
    try {
      const res = await fetch(`/api/pending-operations/${op.id}/commit`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      // getErrorMessage handles both `{ error: string }` and the structured
      // `{ error: { code, message } }` envelope (the latter would otherwise
      // toast "[object Object]") and never surfaces raw English.
      if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))
      const signingUrl = signingUrlOf(json.data)
      if (signingUrl) setSigningPrompt({ title: op.title, url: signingUrl })
      else toast({ title: 'Godkänd', description: op.title })
      setShowCommitDialog(false)
      setSelectedOp(null)
      // Drop the committed op from the bulk selection now: the row leaves
      // the list (and so the selection) only when the refetch lands.
      selection.deselect([op.id])
      afterResolve()
    } catch (err) {
      toast({
        title: 'Misslyckades',
        description: err instanceof Error ? getErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    }
    setIsCommitting(false)
  }

  async function handleCommit() {
    if (!selectedOp) return
    await commitOp(selectedOp)
  }

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
      const titles = new Map(operations.map((op) => [op.id, op.title]))
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
    afterResolve()
    setIsBulkCommitting(false)
  }

  function openRejectDialog(target: PendingOperation | 'bulk') {
    setRejectTarget(target)
    setRejectCategory('')
    setRejectReason('')
  }

  async function handleReject() {
    if (!rejectTarget || !rejectCategory) return
    setIsRejecting(true)
    try {
      const feedback = {
        rejection_category: rejectCategory,
        ...(rejectReason.trim() ? { rejection_reason: rejectReason.trim() } : {}),
      }

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

  const filteredOperations = operations.filter((op) => {
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

  const showBulkControls = activeTab === 'pending'
  // Pending ops that meet two criteria: not high risk (bar the groups one
  // acknowledgment covers) AND the period covering them is open. We exclude
  // locked/closed periods from bulk because they will be rejected at commit
  // time anyway: silently letting the user "select all" and watching some
  // fail is a worse UX than excluding them up front.
  const bulkEligible = useMemo(
    () => filteredOperations.filter(isBulkSelectable),
    [filteredOperations]
  )
  const bulkEligibleIds = useMemo(() => bulkEligible.map((op) => op.id), [bulkEligible])
  // The selection holds only bulk-eligible operations of the current view: a
  // tab, filter or refetch that hides one (approved elsewhere, its period
  // locked) drops it, so the bar and the bulk calls never carry it.
  const selection = useBulkSelection(bulkEligibleIds)
  const selectedIds = selection.selectedIds

  const pendingTotal = filteredOperations.filter((op) => op.status === 'pending').length
  const excludedFromBulk = pendingTotal - bulkEligible.length

  // "Approve all of this type": find bulk-eligible ops with the same bulkActionKey
  function selectAllOfType(key: string) {
    selection.selectOnly(bulkEligible.filter((op) => bulkActionKey(op) === key).map((op) => op.id))
  }

  // Group counts for type-quick-action buttons (only show if 2+ of same type pending)
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const op of bulkEligible) {
      const key = bulkActionKey(op)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries()).filter(([, count]) => count >= 2)
  }, [bulkEligible])

  const selectedCount = selectedIds.size

  // Selected high-risk operations that join only under the dialog's one
  // acknowledgment (crm#1489), and what that acknowledgment approves.
  const selectedGroupOps = useMemo(
    () => bulkEligible.filter((op) => selectedIds.has(op.id) && op.risk_level === 'high'),
    [bulkEligible, selectedIds],
  )
  const groupSummary = useMemo(() => summarizeSharedAcknowledgment(selectedGroupOps), [selectedGroupOps])
  const bulkConfirmCount = selectedCount - (groupAcknowledged ? 0 : selectedGroupOps.length)

  const selectedBreakdown = useMemo(() => {
    const counts = new Map<string, number>()
    for (const op of bulkEligible) {
      if (selectedIds.has(op.id) && op.risk_level !== 'high') {
        const key = bulkActionKey(op)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries()).map(([type, count]) => ({ type, count }))
  }, [bulkEligible, selectedIds])

  // Selected operations that carry a compliance warning. The bulk
  // confirmation says how many, so "Godkänn alla" cannot carry a warning past
  // an approver who never scrolled to its row (crm#1003).
  const selectedWarnedCount = useMemo(
    () => bulkEligible.filter((op) => selectedIds.has(op.id) && complianceWarningOf(op) != null).length,
    [bulkEligible, selectedIds],
  )

  // The instructions the agent retrieved, by the names the Instruktioner page uses: never raw slugs or uuids.
  const retrievedNames = (slugs: readonly string[]) => [...new Set(describeRetrievedSkills(slugs).map((item) => {
    if (item.kind === 'workflow') return tSkills(`skills.${item.id}.name`)
    if (item.kind === 'own') return tSkills('retrieved_own')
    const key = item.kind === 'knowledge' ? `knowledge_names.${item.id.split('/')[1]}` : item.kind === 'analysis' ? `analyses.${item.slug}.name` : null
    return key && tSkills.has(key) ? tSkills(key) : item.kind === 'knowledge' ? item.id.split('/')[1] : item.slug
  }))].join(', ')

  // Source/kicker line for a row and the detail panel: operation type,
  // origin (when an agent staged it) and relative age.
  const sourceLine = (op: PendingOperation) => {
    const isAgent = op.actor_type && op.actor_type !== 'user'
    return [
      operationLabel(op.operation_type, t, op.params),
      isAgent ? (originLabel(op, t) ?? op.actor_label ?? op.actor_type) : null,
      op.agent_metadata?.skills_loaded?.length ? t('skills_retrieved', { skills: retrievedNames(op.agent_metadata.skills_loaded) }) : null,
      formatRelativeTime(op.created_at),
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const detailOp = detailOpId
    ? filteredOperations.find((op) => op.id === detailOpId) ?? null
    : null
  const detailPeriod = detailOp ? getPeriodStatus(detailOp) : null
  const detailPeriodLocked = detailPeriod != null && detailPeriod.status !== 'open'
  const detailConversationId = detailOp?.agent_metadata?.conversation_id ?? null
  // The open daily batch's own review dialog (the same props for each).
  const BatchReviewDialog = batchReview ? DAILY_BATCH_DIALOG[batchReview.type] : null

  const SEG_TABS: Array<{ tab: ViewTab; labelKey: string }> = [
    { tab: 'pending', labelKey: 'tab_pending' },
    { tab: 'history', labelKey: 'tab_history' },
  ]

  return (
    <AccountNamesContext.Provider value={accountNames}>
    <div className="space-y-8">
      {/* Page header (concept scene 11): title + Godkänn alla */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        {activeTab === 'pending' && bulkEligible.length > 0 && (
          <Button size="sm"
            disabled={isBulkCommitting || isRejecting}
            onClick={() => {
              selection.selectAll()
              setGroupAcknowledged(false)
              setShowBulkDialog(true)
            }}
          >
            {t('approve_all', { count: bulkEligible.length })}
          </Button>
        )}
      </div>

      {conversationFilter && (
        <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <ChatBubbleLeftIcon className="h-4 w-4 text-muted-foreground" />
            <span>
              {t('conversation_filter_label')}{' '}
              <span className="font-mono">#{conversationFilter.slice(0, 8)}</span>
            </span>
          </div>
          <Button
            size="sm"
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
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={activeTab}
          onChange={setActiveTab}
          options={SEG_TABS.map(({ tab, labelKey }) => ({
            value: tab,
            label: t(labelKey),
            count: tab === 'pending' ? pendingCount ?? 0 : undefined,
          }))}
        />
        {activeTab === 'pending' && (
          <Button
            size="sm"
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
        {isRefreshing && !isLoading && (
          <SpinnerIcon
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-label={t('refreshing')}
          />
        )}
        <div className="ml-auto">
          <ContextPicker
            value={sourceFilter}
            onChange={(id) => setSourceFilter(id as SourceFilter)}
            triggerLabel={sourceFilterLabels(t)[sourceFilter]}
            items={[
              { id: 'all', label: t('tab_all') },
              { id: 'agent', label: t('tab_agent') },
              { id: 'high_risk', label: t('tab_high_risk') },
            ]}
          />
        </div>
      </div>

      <div>
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
              size="sm"
              disabled={isBulkCommitting || isRejecting}
              onClick={() => {
                setGroupAcknowledged(false)
                setShowBulkDialog(true)
              }}
            >
              {t('approve_count', { count: selectedCount })}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={isRejecting || isBulkCommitting}
              onClick={() => openRejectDialog('bulk')}
            >
              {t('reject_count', { count: selectedCount })}
            </Button>
            {typeCounts.length >= 2 &&
              typeCounts.map(([type, count]) => (
                <button
                  key={type}
                  type="button"
                  className={QUIET_LINK_CLASS}
                  onClick={() => selectAllOfType(type)}
                >
                  {bulkActionKeyLabel(type, t)} ({count})
                </button>
              ))}
            {excludedFromBulk > 0 && (
              <span className="text-muted-foreground">
                {t('bulk_excluded_note', { count: excludedFromBulk })}
              </span>
            )}
          </BulkSelectionBar>
        )}

        {isLoading ? (
          <DataListLoading />
        ) : filteredOperations.length === 0 ? (
          activeTab === 'pending' ? (
            /* Concept empty state: the queue is the good news. */
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <CheckIcon className="h-9 w-9 text-success" strokeWidth={2} aria-hidden />
              <p className="mt-3 font-display text-xl">{t('empty_pending_title')}</p>
              <p className="mt-1.5 max-w-[44ch] text-[13px] text-muted-foreground">
                {t('empty_pending_description')}
              </p>
            </div>
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
              const isAgent = op.actor_type && op.actor_type !== 'user' && !batchType
              // High risk, and a registration of an already-booked invoice
              // (it cannot be undone): the consent sentence the approval
              // confirms in a dialog.
              const rowConsent = rowConsentSentence(op, t)
              const complianceWarning = complianceWarningOf(op)

              if (op.status !== 'pending') {
                // Historik row (concept k-row): status chip + text + sub line.
                const resolvedAt = op.resolved_at ?? op.created_at
                const sub = [
                  formatRelativeTime(resolvedAt),
                  operationLabel(op.operation_type, t, op.params),
                  originLabel(op, t),
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
                      'group flex cursor-pointer items-start gap-3 border-b border-border px-1 py-3 transition-colors duration-150',
                      detailOpId === op.id ? 'bg-secondary/25' : 'hover:bg-secondary/35',
                    )}
                  >
                    {/* Same actor mark as the pending rows, minus the curved
                        op-thread (it points at an action row history lacks). */}
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground"
                      aria-hidden
                    >
                      {isAgent ? <CpuChipIcon className="h-3.5 w-3.5" /> : <ClipboardDocumentCheckIcon className="h-3.5 w-3.5" />}
                    </span>
                    {/* Chips mark exceptions: an approved operation is the
                        normal outcome and reads as muted text. */}
                    {op.status === 'committed' && signingUrlOf(op.result_data) ? (
                      // Approved but locked at Skatteverket until signed (crm#1478).
                      <Badge variant="warning" className="mt-0.5 shrink-0 font-normal">{tSigning('sent_badge')}</Badge>
                    ) : op.status === 'committed' && !isAutoExpired(op) ? (
                      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">{t('badge_approved')}</span>
                    ) : (
                      <Badge
                        variant={
                          isAutoExpired(op)
                            ? 'secondary'
                            : op.status === 'failed_partial'
                              ? 'warning'
                              : 'destructive'
                        }
                        className="mt-0.5 shrink-0 font-normal"
                      >
                        {isAutoExpired(op)
                          ? t('badge_auto_expired')
                          : op.status === 'failed_partial'
                            ? t('badge_failed_partial')
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
              // two decisions as hover-revealed icon buttons. The kicker
              // (type, origin, retrieved instructions) and the consent
              // sentence live in the slide-over the row opens.
              const approveLabel = batchType ? t(DAILY_BATCH_REVIEW_LABEL_KEY[batchType]) : t('approve')
              const BatchIcon = batchType ? DAILY_BATCH_ICON[batchType] : null
              return (
                <div
                  key={op.id}
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
                    'group flex cursor-pointer items-center gap-3 border-b border-border px-1 py-2 transition-colors duration-150',
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
                      <Checkbox
                        checked={isSelected}
                        onClick={(e) => {
                          shiftHeld.current = e.shiftKey
                        }}
                        onCheckedChange={() => selection.toggle(op.id, shiftHeld.current)}
                        aria-label={t('select_operation_aria')}
                        className={cn(
                          'border-foreground duration-150',
                          isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
                        )}
                      />
                    )}
                  </span>
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground"
                    aria-hidden
                  >
                    {BatchIcon ? (
                      <BatchIcon className="h-3.5 w-3.5" />
                    ) : isAgent ? (
                      <CpuChipIcon className="h-3.5 w-3.5" />
                    ) : (
                      <ClipboardDocumentCheckIcon className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
                    {/* A daily batch reads in its own words, with what it
                        does as the hover text. */}
                    <span className="min-w-0 truncate" title={runRow?.detail}>
                      {runRow?.title ?? op.title}
                    </span>
                    {/* The staged compliance warning stays on the row, as a
                        truncated suffix: approving from the row or with
                        "Godkänn alla" must not pass it unseen (crm#1003).
                        The slide-over has it in full. */}
                    {complianceWarning && !isRun && (
                      <span
                        className="flex min-w-[35%] flex-1 items-center gap-1 text-[12.5px] text-attn"
                        title={complianceWarningText(complianceWarning)}
                      >
                        <ExclamationTriangleIcon className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="min-w-0 truncate">{complianceWarningText(complianceWarning)}</span>
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatRelativeTime(op.created_at)}
                  </span>
                  {/* Risk chip (concept op-risk), exceptions only: low risk is
                      the normal case and a chip on every row said nothing. */}
                  {op.risk_level !== 'low' && !isRun && (
                    <Badge
                      variant={op.risk_level === 'high' ? 'destructive' : 'outline'}
                      className="shrink-0 font-normal"
                    >
                      {op.risk_level === 'high' ? t('badge_high_risk') : t('badge_medium_risk')}
                    </Badge>
                  )}
                  <span className={cn('flex shrink-0 items-center gap-1', HOVER_REVEAL_CLASS)}>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-success hover:text-success"
                      aria-label={approveLabel}
                      title={periodLocked ? t('period_locked_short') : approveLabel}
                      disabled={periodLocked || isCommitting || isBulkCommitting}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (periodLocked) return
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
                          void commitOp(op)
                        }
                      }}
                    >
                      <CheckIcon className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={t('reject')}
                      title={t('reject')}
                      disabled={isRejecting}
                      onClick={(e) => {
                        e.stopPropagation()
                        openRejectDialog(op)
                      }}
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </Button>
                  </span>
                </div>
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
              <SlideOverBody className="space-y-4">
                {detailPeriodLocked && detailPeriod && detailOp.status === 'pending' && (
                  <PeriodLockBanner period={detailPeriod} />
                )}
                {/* The operation itself in its own box (concept): what the
                    agent is about to do, clearly framed. `detail`: this is
                    the review surface, where a preview may also show the
                    objects involved (the verifikat's lines, the document). */}
                <div className="rounded-lg border border-border p-4">
                  <OperationPreview op={detailOp} detail />
                </div>
                {/* The agent's audit-trail note for this operation (the
                    `notes` tool input): the approver should read why, not
                    only what. */}
                {typeof detailOp.params?.notes === 'string' && detailOp.params.notes.trim() !== '' && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {t('note_label')}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-snug">{detailOp.params.notes}</p>
                  </div>
                )}
                {detailOp.status === 'pending' && singleActionWarning(detailOp.operation_type, detailOp.params, t) && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-xs leading-snug text-muted-foreground">
                      {singleActionWarning(detailOp.operation_type, detailOp.params, t)}
                    </p>
                  </div>
                )}
                {detailOp.status === 'rejected' && detailOp.rejection_category && detailOp.rejection_category !== 'expired' && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-xs leading-snug text-muted-foreground">
                      Avvisad: {rejectionCategoryLabel(detailOp.rejection_category)}
                      {detailOp.rejection_reason ? `, "${detailOp.rejection_reason}"` : ''}
                    </p>
                  </div>
                )}
                {detailOp.status === 'committed' && signingUrlOf(detailOp.result_data) && (
                  <SigningStep url={signingUrlOf(detailOp.result_data)!} afterwards />
                )}
                {isAutoExpired(detailOp) && (
                  <p className="text-xs text-muted-foreground">{t('auto_expired_detail')}</p>
                )}
                {detailOp.status === 'failed_partial' && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-xs leading-snug text-muted-foreground">
                      {t('failed_partial_detail')}
                      {failedPartialPostedIds(detailOp) && (
                        <span className="font-mono"> ({failedPartialPostedIds(detailOp)})</span>
                      )}
                    </p>
                  </div>
                )}
              </SlideOverBody>
              <SlideOverFooter>
                {detailConversationId && (
                  <button
                    type="button"
                    className={cn(QUIET_LINK_CLASS, 'mr-auto')}
                    onClick={() => {
                      setConversationFilter(detailConversationId)
                      setDetailOpId(null)
                    }}
                  >
                    {t('show_conversation')}
                  </button>
                )}
                {detailOp.status === 'pending' && (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => openRejectDialog(detailOp)}
                      disabled={isRejecting}
                    >
                      {t('reject')}
                    </Button>
                    <Button
                      disabled={detailPeriodLocked || isCommitting}
                      title={detailPeriodLocked ? 'Perioden är låst' : undefined}
                      onClick={() => {
                        // Same risk gate as the review-row pill: the detail
                        // panel already shows the full preview, so low/medium
                        // commit directly; only high risk keeps the dialog.
                        // A daily batch has its own review dialog.
                        const detailBatchType = dailyBatchTypeOf(detailOp.operation_type)
                        if (detailBatchType) {
                          setDetailOpId(null)
                          setBatchReview({ id: detailOp.id, type: detailBatchType })
                        } else if (detailOp.risk_level === 'high') {
                          setSelectedOp(detailOp)
                          setShowCommitDialog(true)
                        } else {
                          void commitOp(detailOp)
                        }
                      }}
                    >
                      {t('approve')}
                    </Button>
                  </>
                )}
              </SlideOverFooter>
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
        <DialogContent className="sm:max-w-md">
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

      {/* Commit confirmation dialog */}
      <ConfirmationDialog
        open={showCommitDialog}
        onOpenChange={setShowCommitDialog}
        title={selectedOp?.title || t('approve_operation_title')}
        warningText={selectedOp ? singleActionWarning(selectedOp.operation_type, selectedOp.params, t) : ''}
        confirmLabel={t('approve')}
        isSubmitting={isCommitting}
        onConfirm={handleCommit}
      >
        {selectedOp && <OperationPreview op={selectedOp} />}
      </ConfirmationDialog>

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
          const ids = Array.from(selectedIds).filter((id) => groupAcknowledged || !groupIds.has(id))
          void handleBulkCommit(ids, groups)
        }}
      >
        <div className="space-y-3 text-sm">
          <p>{t('bulk_confirm_intro')}</p>
          {selectedBreakdown.length > 0 && (
            <ul className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2">
              {selectedBreakdown.map(({ type, count }) => (
                <li key={type} className="flex justify-between font-mono tabular-nums">
                  <span className="font-sans">{bulkActionLabel(type, count, t)}</span>
                  <span className="text-muted-foreground">{count}</span>
                </li>
              ))}
            </ul>
          )}
          {/* Routine high-risk rows (crm#1489): one acknowledgment for the
              whole group, stating what it posts, instead of one per row. */}
          {selectedGroupOps.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2">
              <p className="font-medium">{t('shared_ack_title', { count: groupSummary.count })}</p>
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
                    <dt className="text-muted-foreground">{t('shared_ack_incoming')}</dt>
                    <dd>{formatCurrency(groupSummary.incoming)}</dd>
                  </>
                )}
                {groupSummary.outgoing > 0 && (
                  <>
                    <dt className="text-muted-foreground">{t('shared_ack_outgoing')}</dt>
                    <dd>{formatCurrency(groupSummary.outgoing)}</dd>
                  </>
                )}
              </dl>
              {groupSummary.accounts.length > 0 && (
                <table className="w-full text-xs tabular-nums">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground">
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

      {/* Reject dialog: a required category plus an optional free-text reason,
          so every rejection a person makes says what was wrong. Doubles as the
          bulk-reject confirmation; the feedback then applies to every selected op. */}
      <Dialog open={rejectTarget != null} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {rejectTarget === 'bulk'
                ? t('reject_bulk_title', { count: selectedCount })
                : t('reject_title')}
            </DialogTitle>
            {/* data-ph-mask: the operation title carries counterparty and amount */}
            <DialogDescription data-ph-mask="">
              {rejectTarget === 'bulk'
                ? t('reject_bulk_description')
                : rejectTarget?.title}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="reject-category">
                {t('reject_category_label')}
              </label>
              <Select
                value={rejectCategory}
                onValueChange={(v) => setRejectCategory(v as PendingOperationRejectionCategory)}
              >
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
              <label className="text-sm font-medium" htmlFor="reject-reason">
                {t('reject_note_label')}
              </label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder={t('reject_note_placeholder')}
                rows={3}
                maxLength={2000}
              />
              <p className="text-xs text-muted-foreground">{t('reject_note_help')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={isRejecting}>
              {tCommon('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleReject} loading={isRejecting} disabled={!rejectCategory}>
              {rejectTarget === 'bulk' ? t('reject_count', { count: selectedCount }) : t('reject')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* What a bulk approval left undone, one line per operation with the
          reason (crm#1488): the footer of the confirmation promises it. */}
      <Dialog open={bulkOutcome != null} onOpenChange={(open) => { if (!open) setBulkOutcome(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('bulk_outcome_title')}</DialogTitle>
            <DialogDescription>{bulkOutcome?.summary}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto text-[13px]">
            {bulkOutcome?.items.map((item) => (
              <li key={item.id} className="border-b border-border pb-2 last:border-b-0">
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
