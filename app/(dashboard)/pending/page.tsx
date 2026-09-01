'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DataListEmpty, DataListLoading } from '@/components/ui/data-list'
import { ContextPicker } from '@/components/common/ContextPicker'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { CHECKBOX_REVEAL_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
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
import { cn, formatDate } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { createClient } from '@/lib/supabase/client'
import { booksInvoicesOnIssue } from '@/lib/bookkeeping/booking-mode'
import {
  ClipboardCheck,
  Bot,
  Check,
  ChevronRight,
  Info,
  Loader2,
  Lock,
  MessageSquare,
  AlertTriangle,
  X,
  ArrowDownUp,
} from 'lucide-react'
import type {
  PendingOperation,
  PendingOperationRejectionCategory,
} from '@/types'
import { OperationPreview, AccountNamesContext } from '@/components/pending-operations/OperationPreview'
import { useAccountNamesSource } from '@/components/pending-operations/use-account-names'
import {
  operationLabel,
  singleActionWarning,
  REJECTION_CATEGORY_LABELS,
} from '@/components/pending-operations/vocabulary'

// Terse per-type labels used in the bulk confirmation dialog list. Phrased so
// they read naturally under the heading "Genom att bekräfta utförs följande:".
const bulkActionDescriptions: Record<string, (count: number) => string> = {
  create_transaction: (n) =>
    n === 1 ? 'En transaktion skapas.' : `${n} transaktioner skapas.`,
  create_customer: (n) => (n === 1 ? 'En ny kund skapas.' : `${n} nya kunder skapas.`),
  create_invoice: (n) =>
    n === 1 ? 'Ett fakturautkast skapas (skickas inte).' : `${n} fakturautkast skapas (skickas inte).`,
  categorize_transaction: (n) =>
    n === 1 ? 'En transaktion kategoriseras och bokförs.' : `${n} transaktioner kategoriseras och bokförs.`,
  match_transaction_invoice: (n) =>
    n === 1 ? 'En transaktion matchas mot en faktura.' : `${n} transaktioner matchas mot fakturor.`,
  attach_document_to_transaction: (n) =>
    n === 1 ? 'Ett dokument bifogas en transaktion.' : `${n} dokument bifogas transaktioner.`,
  uncategorize_transaction: (n) =>
    n === 1 ? 'En kategorisering tas bort.' : `${n} kategoriseringar tas bort.`,
}

function bulkActionLabel(operationType: string, count: number, t: (key: string) => string): string {
  const fn = bulkActionDescriptions[operationType]
  if (fn) return fn(count)
  return `${count} × ${operationLabel(operationType, t)}`
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

// Concept gact buttons (scene 11): tinted outline pills under the op text.
// The tint is sanctioned here by the concept spec: approve reads sage,
// reject terracotta, details neutral.
const GACT_CLASS =
  'inline-flex items-center gap-1.5 rounded-full border px-3.5 py-[5px] text-xs transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50'
const GACT_OK_CLASS = 'border-success/40 text-success hover:bg-success/10'
const SORT_ORDER_STORAGE_KEY = 'pending.sortOrder'
const GACT_NO_CLASS = 'border-destructive/40 text-destructive hover:bg-destructive/10'
const GACT_NEUTRAL_CLASS =
  'border-border text-muted-foreground hover:bg-secondary/40 hover:text-foreground'

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
    case 'cron':
      return t('origin_cron')
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
      <Lock className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
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
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkDialog, setShowBulkDialog] = useState(false)
  const [isBulkCommitting, setIsBulkCommitting] = useState(false)
  // Reject dialog state: separate from the generic destructive-confirm so we
  // can ask for a category + free-text reason that feeds back to the agent.
  // 'bulk' targets the current checkbox selection instead of a single op.
  const [rejectTarget, setRejectTarget] = useState<PendingOperation | 'bulk' | null>(null)
  const [rejectCategory, setRejectCategory] = useState<PendingOperationRejectionCategory | ''>('')
  const [rejectReason, setRejectReason] = useState('')
  const [isRejecting, setIsRejecting] = useState(false)
  const { toast } = useToast()
  // Whether the "Bokför utkasten" toast CTA leads anywhere: bulk Bokför on
  // /invoices only selects drafts when the company books at issue. Under
  // kontantmetoden or deferred booking (#967) the CTA would be a dead end,
  // so it stays suppressed (false until settings load: suppressing is the
  // safe direction, the neutral hint sentence still shows).
  // Derived from the session-cached settings row (lib/reference-data); false
  // until the row is available, suppressing being the safe direction.
  const { settings: companySettings } = useCompanySettings()
  const invoiceDraftsCtaUseful = companySettings ? booksInvoicesOnIssue(companySettings) : false

  // Read ?conversation= once on mount so deep-links from the agent context
  // strip filter the list automatically.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const conv = url.searchParams.get('conversation')
    if (conv) setConversationFilter(conv)
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
      if (activeTab === 'pending') {
        const res = await fetch(`/api/pending-operations?status=pending&order=${sortOrder}`)
        // A JSON error body parses fine but carries no data: without this
        // check a failed refresh would blank the list and zero the badge
        // instead of keeping current rows and surfacing the error toast.
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!isCurrent()) return
        setOperations(json.data ?? [])
        setPendingCount(json.count ?? json.data?.length ?? 0)
        loadedTabRef.current = 'pending'
      } else {
        // The API is single-status per fetch: Historik merges godkända and
        // avvisade, newest resolution first.
        const [committedRes, rejectedRes] = await Promise.all([
          fetch('/api/pending-operations?status=committed'),
          fetch('/api/pending-operations?status=rejected'),
        ])
        if (!committedRes.ok || !rejectedRes.ok) {
          throw new Error(`HTTP ${committedRes.status}/${rejectedRes.status}`)
        }
        const [committed, rejected] = await Promise.all([committedRes.json(), rejectedRes.json()])
        if (!isCurrent()) return
        const merged = ([...(committed.data ?? []), ...(rejected.data ?? [])] as PendingOperation[]).sort(
          (a, b) => (b.resolved_at ?? b.created_at).localeCompare(a.resolved_at ?? a.created_at),
        )
        setOperations(merged)
        const pc = committed.counts?.pending ?? rejected.counts?.pending
        if (typeof pc === 'number') setPendingCount(pc)
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
  }, [activeTab, sortOrder, toast])

  useEffect(() => {
    fetchOperations()
  }, [fetchOperations])

  // Realtime subscription: refetch when ANY pending_operations row changes for
  // this company. RLS scopes the channel automatically: we don't see other
  // tenants' events. We refetch the whole list (rather than patching state
  // in-place) so server-side filtering, sorting, and computed fields stay in
  // sync with whatever the API route returned, including all tab counts.
  // Trailing debounce: bulk actions emit one event per row, which previously
  // stampeded 4 requests per event (list + 3 counts); the burst now collapses
  // into a single refetch after the last event.
  useEffect(() => {
    const supabase = createClient()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel('pending_operations:list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_operations' },
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
  }, [fetchOperations])

  // Clear selection when filters/tab change
  useEffect(() => {
    setSelectedIds(new Set())
  }, [activeTab, sourceFilter, conversationFilter])

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
      toast({ title: 'Godkänd', description: op.title })
      setShowCommitDialog(false)
      setSelectedOp(null)
      // Drop the committed op from the bulk selection: the row leaves the
      // pending list on refresh, but a stale id would keep inflating the
      // bulk bar and ride along into bulk-commit.
      setSelectedIds((prev) => {
        if (!prev.has(op.id)) return prev
        const next = new Set(prev)
        next.delete(op.id)
        return next
      })
      fetchOperations()
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

  async function handleBulkCommit(ids: string[]) {
    if (ids.length === 0) return
    setIsBulkCommitting(true)
    try {
      const res = await fetch('/api/pending-operations/bulk-commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))

      const summary = json.data?.summary as
        | { committed: number; failed: number; skipped: number; rejected: number }
        | undefined

      // Committed create_invoice ops land as unnumbered DRAFTS: point the
      // user at the draft view where bulk Bokför finishes the job.
      const results = (json.data?.results ?? []) as Array<{ id: string; status: string }>
      const committedIds = new Set(
        results.filter((r) => r.status === 'committed').map((r) => r.id),
      )
      const committedInvoiceDrafts = operations.some(
        (op) => committedIds.has(op.id) && op.operation_type === 'create_invoice',
      )
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

      if (summary) {
        const parts: string[] = []
        if (summary.committed > 0) parts.push(`${summary.committed} godkända`)
        if (summary.failed > 0) parts.push(`${summary.failed} misslyckades`)
        if (summary.rejected > 0) parts.push(`${summary.rejected} avvisade`)
        if (summary.skipped > 0) parts.push(`${summary.skipped} hoppades över`)

        toast({
          title: summary.failed > 0 ? 'Klart med fel' : 'Godkänt',
          description: committedInvoiceDrafts
            ? `${parts.join(', ')}. ${t('bulk_invoice_drafts_hint')}`
            : parts.join(', '),
          variant: summary.failed > 0 ? 'destructive' : 'default',
          ...draftsCta,
        })
      } else {
        toast({ title: 'Godkänt', ...draftsCta })
      }

      setShowBulkDialog(false)
      setSelectedIds(new Set())
      fetchOperations()
    } catch (err) {
      toast({
        title: 'Misslyckades',
        description: err instanceof Error ? getErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    }
    setIsBulkCommitting(false)
  }

  function openRejectDialog(target: PendingOperation | 'bulk') {
    setRejectTarget(target)
    setRejectCategory('')
    setRejectReason('')
  }

  async function handleReject() {
    if (!rejectTarget) return
    setIsRejecting(true)
    try {
      const feedback = {
        ...(rejectCategory ? { rejection_category: rejectCategory } : {}),
        ...(rejectReason.trim() ? { rejection_reason: rejectReason.trim() } : {}),
      }

      if (rejectTarget === 'bulk') {
        const res = await fetch('/api/pending-operations/bulk-reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: Array.from(selectedIds), ...feedback }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))

        const summary = json.data?.summary as
          | { rejected: number; skipped: number; failed: number }
          | undefined
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
        setSelectedIds(new Set())
      } else {
        const hasFeedback = Object.keys(feedback).length > 0
        const res = await fetch(`/api/pending-operations/${rejectTarget.id}/reject`, {
          method: 'POST',
          ...(hasFeedback
            ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feedback) }
            : {}),
        })
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          throw new Error(getErrorMessage(json, { statusCode: res.status }))
        }
        toast({ title: 'Avvisad', description: rejectTarget.title })
      }

      setRejectTarget(null)
      fetchOperations()
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
          op.actor_type === 'cron' ||
          op.actor_type === 'agent_chat'
        )
      case 'high_risk':
        return op.risk_level === 'high'
      case 'all':
      default:
        return true
    }
  })

  const showBulkControls = activeTab === 'pending'
  // Pending ops that meet two criteria: not high risk AND the period covering
  // them is open. We exclude locked/closed periods from bulk because they will
  // be rejected at commit time anyway: silently letting the user "select all"
  // and watching some fail is a worse UX than excluding them up front.
  const bulkEligible = useMemo(
    () =>
      filteredOperations.filter((op) => {
        if (op.status !== 'pending') return false
        if (op.risk_level === 'high') return false
        const period = getPeriodStatus(op)
        if (period && period.status !== 'open') return false
        return true
      }),
    [filteredOperations]
  )
  const bulkEligibleIds = useMemo(() => bulkEligible.map((op) => op.id), [bulkEligible])
  const allSelected =
    bulkEligibleIds.length > 0 && bulkEligibleIds.every((id) => selectedIds.has(id))

  const pendingTotal = filteredOperations.filter((op) => op.status === 'pending').length
  const excludedFromBulk = pendingTotal - bulkEligible.length

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(bulkEligibleIds))
    }
  }

  // "Approve all of this type": find ops with the same operation_type that are bulk-eligible
  function selectAllOfType(operationType: string) {
    const ids = bulkEligible
      .filter((op) => op.operation_type === operationType)
      .map((op) => op.id)
    setSelectedIds(new Set(ids))
  }

  // Group counts for type-quick-action buttons (only show if 2+ of same type pending)
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const op of bulkEligible) {
      counts.set(op.operation_type, (counts.get(op.operation_type) ?? 0) + 1)
    }
    return Array.from(counts.entries()).filter(([, count]) => count >= 2)
  }, [bulkEligible])

  const selectedCount = selectedIds.size

  const selectedBreakdown = useMemo(() => {
    const counts = new Map<string, number>()
    for (const op of bulkEligible) {
      if (selectedIds.has(op.id)) {
        counts.set(op.operation_type, (counts.get(op.operation_type) ?? 0) + 1)
      }
    }
    return Array.from(counts.entries()).map(([type, count]) => ({ type, count }))
  }, [bulkEligible, selectedIds])

  // Source/kicker line for a row and the detail panel: operation type,
  // origin (when an agent staged it) and relative age.
  const sourceLine = (op: PendingOperation) => {
    const isAgent = op.actor_type && op.actor_type !== 'user'
    return [
      operationLabel(op.operation_type, t),
      isAgent ? (originLabel(op, t) ?? op.actor_label ?? op.actor_type) : null,
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

  const SEG_TABS: Array<{ tab: ViewTab; labelKey: string }> = [
    { tab: 'pending', labelKey: 'tab_pending' },
    { tab: 'history', labelKey: 'tab_history' },
  ]

  return (
    <AccountNamesContext.Provider value={accountNames}>
    <div className="space-y-8">
      {/* Page header (concept scene 11): title + Godkänn alla */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        {activeTab === 'pending' && bulkEligible.length > 0 && (
          <Button
            disabled={isBulkCommitting || isRejecting}
            onClick={() => {
              setSelectedIds(new Set(bulkEligibleIds))
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
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <span>
              {t('conversation_filter_label')}{' '}
              <span className="font-mono">#{conversationFilter.slice(0, 8)}</span>
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
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
            className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
            onClick={toggleSortOrder}
            aria-pressed={sortOrder === 'asc'}
            title={sortOrder === 'asc' ? t('sort_oldest_first') : t('sort_newest_first')}
          >
            <ArrowDownUp className="h-3.5 w-3.5" aria-hidden="true" />
            {sortOrder === 'asc' ? t('sort_oldest_first') : t('sort_newest_first')}
          </Button>
        )}
        {/* Quiet cue that a background reconcile is running (post-action or
            realtime): the list itself never swaps to a spinner for it. */}
        {isRefreshing && !isLoading && (
          <Loader2
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
        {showBulkControls && selectedCount > 0 && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-1 py-2.5 text-[12.5px] animate-fade-in">
            <span className="whitespace-nowrap">
              <strong className="font-semibold tabular-nums">{selectedCount}</strong>{' '}
              {t('bulkbar_selected', { count: selectedCount })}
            </span>
            <Button
              size="sm"
              disabled={isBulkCommitting || isRejecting}
              onClick={() => setShowBulkDialog(true)}
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
                  {operationLabel(type, t)} ({count})
                </button>
              ))}
            {!allSelected && (
              <button type="button" className={QUIET_LINK_CLASS} onClick={toggleSelectAll}>
                {t('select_all_count', { count: bulkEligible.length })}
              </button>
            )}
            {excludedFromBulk > 0 && (
              <span className="text-muted-foreground">
                {t('bulk_excluded_note', { count: excludedFromBulk })}
              </span>
            )}
            <button
              type="button"
              className={QUIET_LINK_CLASS}
              onClick={() => setSelectedIds(new Set())}
            >
              {t('deselect')}
            </button>
          </div>
        )}

        {isLoading ? (
          <DataListLoading />
        ) : filteredOperations.length === 0 ? (
          activeTab === 'pending' ? (
            /* Concept empty state: the queue is the good news. */
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <Check className="h-9 w-9 text-success" strokeWidth={2.5} aria-hidden />
              <p className="mt-3 font-display text-xl">{t('empty_pending_title')}</p>
              <p className="mt-1.5 max-w-[44ch] text-[13px] text-muted-foreground">
                {t('empty_pending_description')}
              </p>
            </div>
          ) : (
            <DataListEmpty
              icon={<ClipboardCheck className="h-6 w-6" />}
              title={t('empty_history_title')}
              description={t('empty_finished_description')}
            />
          )
        ) : (
          <div className="stagger-enter">
            {filteredOperations.map((op) => {
              const period = getPeriodStatus(op)
              const periodLocked = period != null && period.status !== 'open'
              const canBulkSelect =
                showBulkControls && op.status === 'pending' && op.risk_level !== 'high' && !periodLocked
              const isSelected = selectedIds.has(op.id)
              const isAgent = op.actor_type && op.actor_type !== 'user'
              const warningSentence = singleActionWarning(op.operation_type)
              const showHighRiskWarning =
                op.risk_level === 'high' && warningSentence && op.status === 'pending'

              if (op.status !== 'pending') {
                // Historik row (concept k-row): status chip + text + sub line.
                const resolvedAt = op.resolved_at ?? op.created_at
                const sub = [
                  formatRelativeTime(resolvedAt),
                  operationLabel(op.operation_type, t),
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
                      {isAgent ? <Bot className="h-3.5 w-3.5" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                    </span>
                    <Badge
                      variant={
                        isAutoExpired(op)
                          ? 'secondary'
                          : op.status === 'committed'
                            ? 'success'
                            : op.status === 'failed_partial'
                              ? 'warning'
                              : 'destructive'
                      }
                      className="mt-0.5 shrink-0 font-normal"
                    >
                      {isAutoExpired(op)
                        ? t('badge_auto_expired')
                        : op.status === 'committed'
                          ? t('badge_approved')
                          : op.status === 'failed_partial'
                            ? t('badge_failed_partial')
                            : t('badge_rejected')}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] leading-snug">{op.title}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
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
                    <ChevronRight
                      className={cn(
                        'mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-all duration-200',
                        detailOpId === op.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                      )}
                    />
                  </div>
                )
              }

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
                    'group flex cursor-pointer items-start gap-3 border-b border-border px-1 py-4 transition-colors duration-150',
                    detailOpId === op.id ? 'bg-secondary/25' : 'hover:bg-secondary/35',
                    isSelected && 'bg-secondary/40',
                  )}
                >
                  {/* Always-visible selection checkbox (concept .cb) */}
                  <span
                    className="w-[18px] shrink-0 pt-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canBulkSelect && (
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelected(op.id)}
                        aria-label={t('select_operation_aria')}
                        className={cn(
                          'duration-150',
                          isSelected ? 'opacity-100' : CHECKBOX_REVEAL_CLASS,
                        )}
                      />
                    )}
                  </span>
                  {/* Actor column with the curved thread (concept op-thread):
                      drops from the icon and elbows toward the action row. */}
                  <span className="flex w-7 shrink-0 flex-col self-stretch" aria-hidden>
                    <span className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-muted-foreground">
                      {isAgent ? <Bot className="h-3.5 w-3.5" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                    </span>
                    <span className="relative min-h-0 flex-1">
                      <span className="absolute bottom-[11px] left-1/2 top-1 w-3 rounded-bl-lg border-b border-l border-border" />
                    </span>
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="pt-0.5 text-[11px] uppercase tracking-[0.07em] text-muted-foreground">
                      {sourceLine(op)}
                    </div>
                    <div className="mt-1 text-[13.5px] leading-snug">{op.title}</div>
                    {showHighRiskWarning && (
                      <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{warningSentence}</span>
                      </p>
                    )}
                    {/* Action pills under the text (concept gact) */}
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={cn(GACT_CLASS, GACT_OK_CLASS)}
                        disabled={periodLocked || isCommitting || isBulkCommitting}
                        title={periodLocked ? 'Perioden är låst' : undefined}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (periodLocked) return
                          if (op.risk_level === 'high') {
                            // High risk keeps the confirmation dialog: its
                            // warning sentence carries real information.
                            setSelectedOp(op)
                            setShowCommitDialog(true)
                          } else {
                            // Low/medium: the pill on the review row is the
                            // approval; a second Godkann in a dialog restated
                            // what the row already shows.
                            void commitOp(op)
                          }
                        }}
                      >
                        <Check className="h-3.5 w-3.5" />
                        {t('approve')}
                      </button>
                      <button
                        type="button"
                        className={cn(GACT_CLASS, GACT_NO_CLASS)}
                        disabled={isRejecting}
                        onClick={(e) => {
                          e.stopPropagation()
                          openRejectDialog(op)
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                        {t('reject')}
                      </button>
                      <button
                        type="button"
                        className={cn(GACT_CLASS, GACT_NEUTRAL_CLASS)}
                        onClick={(e) => {
                          e.stopPropagation()
                          setDetailOpId(op.id)
                        }}
                      >
                        <Info className="h-3.5 w-3.5" />
                        {t('details_btn')}
                      </button>
                    </div>
                  </div>
                  {/* Risk chip (concept op-risk) */}
                  <Badge
                    variant={op.risk_level === 'high' ? 'destructive' : 'outline'}
                    className="mt-1 shrink-0 font-normal"
                  >
                    {op.risk_level === 'high'
                      ? t('badge_high_risk')
                      : op.risk_level === 'medium'
                        ? t('badge_medium_risk')
                        : t('badge_low_risk')}
                  </Badge>
                </div>
              )
            })}
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
        <SlideOverContent aria-describedby={undefined}>
          {detailOp && (
            <>
              <SlideOverHeader kicker={sourceLine(detailOp)} title={detailOp.title} />
              <SlideOverBody className="space-y-4">
                {detailPeriodLocked && detailPeriod && detailOp.status === 'pending' && (
                  <PeriodLockBanner period={detailPeriod} />
                )}
                {/* The operation itself in its own box (concept): what the
                    agent is about to do, clearly framed. */}
                <div className="rounded-lg border border-border p-4">
                  <OperationPreview op={detailOp} />
                </div>
                {/* The agent's audit-trail note for this operation (the
                    `notes` tool input): the approver should read why, not
                    only what. */}
                {typeof detailOp.params?.notes === 'string' && detailOp.params.notes.trim() !== '' && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {t('note_label')}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-snug">{detailOp.params.notes}</p>
                  </div>
                )}
                {detailOp.status === 'pending' && singleActionWarning(detailOp.operation_type) && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-xs leading-snug text-muted-foreground">
                      {singleActionWarning(detailOp.operation_type)}
                    </p>
                  </div>
                )}
                {detailOp.status === 'rejected' && detailOp.rejection_category && (
                  <div className="rounded-lg border border-border bg-secondary/25 px-3 py-2">
                    <p className="text-xs leading-snug text-muted-foreground">
                      Avvisad: {REJECTION_CATEGORY_LABELS[detailOp.rejection_category]}
                      {detailOp.rejection_reason ? `, "${detailOp.rejection_reason}"` : ''}
                    </p>
                  </div>
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
                        if (detailOp.risk_level === 'high') {
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

      {/* Commit confirmation dialog */}
      <ConfirmationDialog
        open={showCommitDialog}
        onOpenChange={setShowCommitDialog}
        title={selectedOp?.title || t('approve_operation_title')}
        warningText={selectedOp ? singleActionWarning(selectedOp.operation_type) : ''}
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
        title={t('approve_bulk_title', { count: selectedCount })}
        warningText=""
        confirmLabel={t('approve_count', { count: selectedCount })}
        isSubmitting={isBulkCommitting}
        onConfirm={() => handleBulkCommit(Array.from(selectedIds))}
      >
        <div className="space-y-3 text-sm">
          <p>{t('bulk_confirm_intro')}</p>
          <ul className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2">
            {selectedBreakdown.map(({ type, count }) => (
              <li key={type} className="flex justify-between font-mono tabular-nums">
                <span className="font-sans">{bulkActionLabel(type, count, t)}</span>
                <span className="text-muted-foreground">{count}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {t('bulk_confirm_footer')}
          </p>
        </div>
      </ConfirmationDialog>

      {/* Reject dialog: category + free-text reason. Both optional so the user
          can still reject quickly without filling anything in. Doubles as the
          bulk-reject confirmation; the feedback then applies to every selected op. */}
      <Dialog open={rejectTarget != null} onOpenChange={(open) => { if (!open) setRejectTarget(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {rejectTarget === 'bulk'
                ? t('reject_bulk_title', { count: selectedCount })
                : 'Avvisa operation'}
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
                Anledning (valfritt)
              </label>
              <Select
                value={rejectCategory}
                onValueChange={(v) => setRejectCategory(v as PendingOperationRejectionCategory)}
              >
                <SelectTrigger id="reject-category">
                  <SelectValue placeholder="Välj kategori" />
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
                Notering (valfritt)
              </label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="T.ex. fel kund matchades, beloppet stämmer inte med fakturan…"
                rows={3}
                maxLength={2000}
              />
              <p className="text-xs text-muted-foreground">
                Synlig för agenten via gnubok_get_recent_rejections: hjälper den att korrigera nästa förslag.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={isRejecting}>
              Avbryt
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={isRejecting}>
              {isRejecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : rejectTarget === 'bulk' ? (
                t('reject_count', { count: selectedCount })
              ) : (
                'Avvisa'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </AccountNamesContext.Provider>
  )
}
