'use client'

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
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
import { formatCurrency, formatDate } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import {
  ClipboardCheck,
  Loader2,
  ArrowLeftRight,
  Users,
  Receipt,
  CheckCircle2,
  XCircle,
  Bot,
  Lock,
  MessageSquare,
  AlertTriangle,
} from 'lucide-react'
import type {
  PendingOperation,
  PendingOperationStatus,
  PendingOperationRejectionCategory,
} from '@/types'

const operationLabels: Record<string, { label: string; icon: typeof ArrowLeftRight; variant: 'default' | 'secondary' | 'outline' }> = {
  categorize_transaction: { label: 'Kategorisering', icon: ArrowLeftRight, variant: 'default' },
  create_customer: { label: 'Ny kund', icon: Users, variant: 'secondary' },
  create_invoice: { label: 'Ny faktura', icon: Receipt, variant: 'outline' },
  create_transaction: { label: 'Ny transaktion', icon: ArrowLeftRight, variant: 'secondary' },
  mark_invoice_paid: { label: 'Betald faktura', icon: Receipt, variant: 'default' },
  send_invoice: { label: 'Skicka faktura', icon: Receipt, variant: 'outline' },
  mark_invoice_sent: { label: 'Markera skickad', icon: Receipt, variant: 'outline' },
  match_transaction_invoice: { label: 'Fakturamatchning', icon: ArrowLeftRight, variant: 'secondary' },
}

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

function bulkActionLabel(operationType: string, count: number): string {
  const fn = bulkActionDescriptions[operationType]
  if (fn) return fn(count)
  const fallback = operationLabels[operationType]?.label ?? operationType
  return `${count} × ${fallback}`
}

// Full-sentence warning for the single-op confirmation dialog AND the inline
// list-view warning when risk is medium/high. The list-view truncates beyond
// one line; the dialog shows it in full. Order roughly low → high risk so
// reviewers scanning the source see the destructive paths grouped together.
const singleActionWarnings: Record<string, string> = {
  // Low/medium risk — light verifikation work
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
  // High risk — period/year-end/voucher edits. These are the ones the reviewer
  // really needs the warning for, so we keep them concrete: name the
  // irreversibility or compliance consequence, not the generic risk-level.
  lock_period: 'Genom att klicka godkänn så låses perioden — inga nya verifikationer kan bokföras tills den låses upp.',
  unlock_period: 'Genom att klicka godkänn så låses perioden upp. Använd endast för rättelser; lås igen efter.',
  close_period: 'Genom att klicka godkänn så stängs perioden permanent (BFL). Stängningen kan inte ångras.',
  run_year_end: 'Genom att klicka godkänn så körs bokslut: resultatkonton nollställs, perioden låses, nästa period skapas.',
  set_opening_balances: 'Genom att klicka godkänn så bokförs ingående balans i nästa period.',
  run_currency_revaluation: 'Genom att klicka godkänn så bokförs valutaomvärdering (3960/7960).',
  create_voucher: 'Genom att klicka godkänn så bokförs verifikationen med ett nytt löpnummer.',
  correct_entry: 'Genom att klicka godkänn så stornas originalverifikationen och en rättelse bokförs (BFL 5 kap 5§).',
  reverse_entry: 'Genom att klicka godkänn så stornas verifikationen — originalet behålls synligt (BFL 5 kap).',
  credit_invoice: 'Genom att klicka godkänn så skapas en kreditfaktura och originalverifikationen stornas.',
  credit_supplier_invoice: 'Genom att klicka godkänn så krediteras leverantörsfakturan och registreringsverifikationen stornas.',
  approve_supplier_invoice: 'Genom att klicka godkänn så attesteras leverantörsfakturan och blir betalningsbar.',
  convert_invoice: 'Genom att klicka godkänn så konverteras proformafakturan till en riktig faktura med F-nummer.',
  import_sie: 'Genom att klicka godkänn så importeras SIE-filen: räkenskapsperiod, ingående balans och verifikationer skapas.',
  explain_voucher_gap: 'Genom att klicka godkänn så dokumenteras förklaringen för verifikationsluckan (BFNAR 2013:2).',
  post_annual_depreciation: 'Genom att klicka godkänn så bokförs planenlig avskrivning — en verifikation per tillgång.',
}

function singleActionWarning(operationType: string): string {
  return singleActionWarnings[operationType] ?? ''
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

const REJECTION_CATEGORY_LABELS: Record<PendingOperationRejectionCategory, string> = {
  wrong_category: 'Fel kategori / konto',
  wrong_amount: 'Fel belopp',
  duplicate: 'Dubblett',
  wrong_period: 'Fel period',
  other: 'Annat',
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

function CategorizePreview({ data }: { data: Record<string, unknown> }) {
  const vatLines = (data.vat_lines as Array<{ account_number: string; debit_amount: number; credit_amount: number; description: string }>) || []

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Debetkonto</span>
        <span className="font-mono">{String(data.debit_account ?? '')}</span>
        <span className="text-muted-foreground">Kreditkonto</span>
        <span className="font-mono">{String(data.credit_account ?? '')}</span>
        <span className="text-muted-foreground">Belopp</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(data.amount as number, (data.currency as string) || 'SEK')}
        </span>
      </div>
      {vatLines.length > 0 && (
        <div className="border-t pt-2">
          <p className="text-xs text-muted-foreground mb-1">Momsrader</p>
          {vatLines.map((line, i) => (
            <div key={i} className="flex justify-between font-mono text-xs">
              <span>{line.account_number} {line.description}</span>
              <span className="tabular-nums">
                {line.debit_amount > 0 ? `D ${formatCurrency(line.debit_amount)}` : `K ${formatCurrency(line.credit_amount)}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CustomerPreview({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Namn</span>
      <span>{String(data.name ?? '')}</span>
      <span className="text-muted-foreground">Typ</span>
      <span>{String(data.customer_type ?? '')}</span>
      {data.email ? (
        <>
          <span className="text-muted-foreground">E-post</span>
          <span>{String(data.email)}</span>
        </>
      ) : null}
      {data.org_number ? (
        <>
          <span className="text-muted-foreground">Org.nr</span>
          <span className="font-mono">{String(data.org_number)}</span>
        </>
      ) : null}
    </div>
  )
}

function InvoicePreview({ data }: { data: Record<string, unknown> }) {
  const items = (data.items as Array<{ description: string; quantity: number; unit: string; unit_price: number; line_total: number; vat_rate: number }>) || []

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Kund</span>
        <span>{String(data.customer_name ?? '')}</span>
        <span className="text-muted-foreground">Datum</span>
        <span>{String(data.invoice_date ?? '')}</span>
        <span className="text-muted-foreground">Förfallodatum</span>
        <span>{String(data.due_date ?? '')}</span>
      </div>
      {items.length > 0 && (
        <div className="border-t pt-2 space-y-1">
          {items.map((item, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span className="truncate mr-4">{item.description} ({item.quantity} {item.unit})</span>
              <span className="font-mono tabular-nums whitespace-nowrap">
                {formatCurrency(item.line_total, (data.currency as string) || 'SEK')}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="border-t pt-2 grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Netto</span>
        <span className="font-mono tabular-nums text-right">{formatCurrency(data.subtotal as number, (data.currency as string) || 'SEK')}</span>
        <span className="text-muted-foreground">Moms</span>
        <span className="font-mono tabular-nums text-right">{formatCurrency(data.vat_amount as number, (data.currency as string) || 'SEK')}</span>
        <span className="font-medium">Totalt</span>
        <span className="font-mono tabular-nums font-medium text-right">{formatCurrency(data.total as number, (data.currency as string) || 'SEK')}</span>
      </div>
    </div>
  )
}

function CreateTransactionPreview({ data }: { data: Record<string, unknown> }) {
  const amount = data.amount as number
  const currency = (data.currency as string) || 'SEK'

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      <span className="text-muted-foreground">Datum</span>
      <span className="font-mono">{String(data.date ?? '')}</span>
      <span className="text-muted-foreground">Beskrivning</span>
      <span className="truncate">{String(data.description ?? '')}</span>
      <span className="text-muted-foreground">Belopp</span>
      <span className="font-mono tabular-nums">
        {formatCurrency(amount, currency)}
      </span>
      {data.external_id ? (
        <>
          <span className="text-muted-foreground">Extern referens</span>
          <span className="font-mono text-xs truncate">{String(data.external_id)}</span>
        </>
      ) : null}
    </div>
  )
}

function GenericPreview({ data }: { data: Record<string, unknown> }) {
  // Skip period_status here — it's surfaced in the dedicated banner, not the
  // generic key-value dump (otherwise the approver sees the same fact twice).
  const entries = Object.entries(data).filter(([k, v]) => v != null && v !== '' && k !== 'period_status')
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
          <span className={typeof value === 'number' ? 'font-mono tabular-nums' : ''}>
            {String(value)}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

function OperationPreview({ op }: { op: PendingOperation }) {
  switch (op.operation_type) {
    case 'categorize_transaction':
      return <CategorizePreview data={op.preview_data} />
    case 'create_customer':
      return <CustomerPreview data={op.preview_data} />
    case 'create_invoice':
      return <InvoicePreview data={op.preview_data} />
    case 'create_transaction':
      return <CreateTransactionPreview data={op.preview_data} />
    default:
      return <GenericPreview data={op.preview_data} />
  }
}

/**
 * Inline period-lock banner. Renders when the staged operation touches a
 * period that's already locked or closed — the server's commit-time trigger
 * will reject it, so we tell the approver up front rather than letting them
 * click and see a generic "Misslyckades" toast. The fiscal_period_id link
 * goes to the periods management page where unlocking is possible.
 */
function PeriodLockBanner({ period }: { period: PeriodStatusShape }) {
  const lockedThrough = period.lock_date ? formatDate(period.lock_date) : null
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
      <Lock className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      <div className="flex-1">
        <p className="font-medium text-destructive">
          {period.status === 'closed'
            ? 'Perioden är stängd permanent (BFL) — kan inte ändras.'
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

function AgentContextStrip({ op }: { op: PendingOperation }) {
  if (!op.agent_metadata) return null
  const meta = op.agent_metadata
  const shortConv = meta.conversation_id ? meta.conversation_id.slice(0, 8) : null
  const atoms = Array.isArray(meta.atoms_loaded) ? meta.atoms_loaded : []
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <MessageSquare className="h-3 w-3" />
      {shortConv ? (
        <span>
          Konversation <a
            href={`/pending?conversation=${meta.conversation_id}`}
            className="font-mono hover:underline"
            onClick={(e) => e.stopPropagation()}
          >#{shortConv}</a>
        </span>
      ) : null}
      {meta.model ? <span className="font-mono">{meta.model}</span> : null}
      {atoms.length > 0 ? (
        <span className="truncate">atoms: {atoms.join(', ')}</span>
      ) : null}
    </div>
  )
}

type SourceFilter = 'all' | 'agent' | 'high_risk'

export default function PendingOperationsPage() {
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<PendingOperationStatus>('pending')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [conversationFilter, setConversationFilter] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedOp, setSelectedOp] = useState<PendingOperation | null>(null)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkDialog, setShowBulkDialog] = useState(false)
  const [isBulkCommitting, setIsBulkCommitting] = useState(false)
  // Reject dialog state — separate from the generic destructive-confirm so we
  // can ask for a category + free-text reason that feeds back to the agent.
  const [rejectOp, setRejectOp] = useState<PendingOperation | null>(null)
  const [rejectCategory, setRejectCategory] = useState<PendingOperationRejectionCategory | ''>('')
  const [rejectReason, setRejectReason] = useState('')
  const [isRejecting, setIsRejecting] = useState(false)
  const { toast } = useToast()

  // Read ?conversation= once on mount so deep-links from the agent context
  // strip filter the list automatically.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const conv = url.searchParams.get('conversation')
    if (conv) setConversationFilter(conv)
  }, [])

  const fetchOperations = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch(`/api/pending-operations?status=${activeTab}`)
      const json = await res.json()
      setOperations(json.data ?? [])
    } catch {
      toast({ title: 'Kunde inte ladda operationer', variant: 'destructive' })
    }
    setIsLoading(false)
  }, [activeTab, toast])

  useEffect(() => {
    fetchOperations()
  }, [fetchOperations])

  // Realtime subscription: refetch when ANY pending_operations row changes for
  // this company. RLS scopes the channel automatically — we don't see other
  // tenants' events. We refetch the whole list (rather than patching state
  // in-place) so server-side filtering, sorting, and computed fields stay in
  // sync with whatever the API route returned.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('pending_operations:list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_operations' },
        () => { fetchOperations() }
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [fetchOperations])

  // Clear selection when filters/tab change
  useEffect(() => {
    setSelectedIds(new Set())
  }, [activeTab, sourceFilter, conversationFilter])

  async function handleCommit() {
    if (!selectedOp) return
    setIsCommitting(true)
    try {
      const res = await fetch(`/api/pending-operations/${selectedOp.id}/commit`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Misslyckades')
      toast({ title: 'Godkänd', description: selectedOp.title })
      setShowCommitDialog(false)
      setSelectedOp(null)
      fetchOperations()
    } catch (err) {
      toast({
        title: 'Misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    }
    setIsCommitting(false)
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
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Misslyckades')

      const summary = json.data?.summary as
        | { committed: number; failed: number; skipped: number; rejected: number }
        | undefined

      if (summary) {
        const parts: string[] = []
        if (summary.committed > 0) parts.push(`${summary.committed} godkända`)
        if (summary.failed > 0) parts.push(`${summary.failed} misslyckades`)
        if (summary.rejected > 0) parts.push(`${summary.rejected} avvisade`)
        if (summary.skipped > 0) parts.push(`${summary.skipped} hoppades över`)

        toast({
          title: summary.failed > 0 ? 'Klart med fel' : 'Godkänt',
          description: parts.join(', '),
          variant: summary.failed > 0 ? 'destructive' : 'default',
        })
      } else {
        toast({ title: 'Godkänt' })
      }

      setShowBulkDialog(false)
      setSelectedIds(new Set())
      fetchOperations()
    } catch (err) {
      toast({
        title: 'Misslyckades',
        description: err instanceof Error ? err.message : 'Okänt fel',
        variant: 'destructive',
      })
    }
    setIsBulkCommitting(false)
  }

  function openRejectDialog(op: PendingOperation) {
    setRejectOp(op)
    setRejectCategory('')
    setRejectReason('')
  }

  async function handleReject() {
    if (!rejectOp) return
    setIsRejecting(true)
    try {
      const body =
        rejectCategory || rejectReason.trim()
          ? {
              ...(rejectCategory ? { rejection_category: rejectCategory } : {}),
              ...(rejectReason.trim() ? { rejection_reason: rejectReason.trim() } : {}),
            }
          : undefined
      const res = await fetch(`/api/pending-operations/${rejectOp.id}/reject`, {
        method: 'POST',
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error(json.error || 'Misslyckades')
      }
      toast({ title: 'Avvisad', description: rejectOp.title })
      setRejectOp(null)
      fetchOperations()
    } catch (err) {
      toast({
        title: 'Kunde inte avvisa',
        description: err instanceof Error ? err.message : 'Okänt fel',
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
        return op.actor_type === 'api_key' || op.actor_type === 'mcp_oauth' || op.actor_type === 'cron'
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
  // be rejected at commit time anyway — silently letting the user "select all"
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
  const someSelected = bulkEligibleIds.some((id) => selectedIds.has(id))

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

  // "Approve all of this type" — find ops with the same operation_type that are bulk-eligible
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Granskning"
        description="Operationer som väntar på godkännande"
      />

      {conversationFilter && (
        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <span>
              Visar operationer från konversation{' '}
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
            Rensa filter
          </Button>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as PendingOperationStatus)}>
        <TabsList>
          <TabsTrigger value="pending">Väntande</TabsTrigger>
          <TabsTrigger value="committed">Godkända</TabsTrigger>
          <TabsTrigger value="rejected">Avvisade</TabsTrigger>
        </TabsList>
      </Tabs>

      <Tabs value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
        <TabsList>
          <TabsTrigger value="all">Alla</TabsTrigger>
          <TabsTrigger value="agent">Från agent</TabsTrigger>
          <TabsTrigger value="high_risk">Hög risk</TabsTrigger>
        </TabsList>
      </Tabs>

      {showBulkControls && bulkEligible.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="select-all"
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={() => toggleSelectAll()}
              aria-label="Markera alla"
            />
            <label htmlFor="select-all" className="text-sm cursor-pointer">
              {selectedCount > 0
                ? `${selectedCount} valda`
                : excludedFromBulk > 0
                  ? `Markera (${bulkEligible.length} av ${pendingTotal} — ${excludedFromBulk} kräver enskild granskning)`
                  : `Markera alla (${bulkEligible.length})`}
            </label>
          </div>

          {typeCounts.length > 0 && selectedCount === 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">Snabbval:</span>
              {typeCounts.map(([type, count]) => {
                const config = operationLabels[type] || { label: type }
                return (
                  <Button
                    key={type}
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    onClick={() => selectAllOfType(type)}
                  >
                    {config.label} ({count})
                  </Button>
                )
              })}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {selectedCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-3 text-xs"
                onClick={() => setSelectedIds(new Set())}
              >
                Avmarkera
              </Button>
            )}
            <Button
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={selectedCount === 0 || isBulkCommitting}
              onClick={() => setShowBulkDialog(true)}
            >
              Godkänn valda ({selectedCount})
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      ) : filteredOperations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
              <ClipboardCheck className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="font-medium">
              {activeTab === 'pending'
                ? 'Inga väntande operationer'
                : activeTab === 'committed'
                  ? 'Inga godkända operationer'
                  : 'Inga avvisade operationer'}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {activeTab === 'pending'
                ? 'När en operation kräver godkännande visas den här för granskning.'
                : 'Operationer du har godkänt eller avvisat visas här.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filteredOperations.map((op) => {
            const config = operationLabels[op.operation_type] || { label: op.operation_type, icon: ClipboardCheck, variant: 'default' as const }
            const isExpanded = expandedId === op.id
            const period = getPeriodStatus(op)
            const periodLocked = period != null && period.status !== 'open'
            const canBulkSelect =
              showBulkControls && op.status === 'pending' && op.risk_level !== 'high' && !periodLocked
            const isSelected = selectedIds.has(op.id)
            const warningSentence = singleActionWarning(op.operation_type)
            const showHighRiskWarning = op.risk_level === 'high' && warningSentence && op.status === 'pending'

            return (
              <Card
                key={op.id}
                className="transition-colors hover:border-primary/30"
              >
                <CardContent className="py-4">
                  <div
                    className="flex items-start justify-between gap-4 cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : op.id)}
                  >
                    {canBulkSelect && (
                      <div
                        className="flex items-center pt-0.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleSelected(op.id)}
                          aria-label="Välj operation"
                        />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <Badge variant={config.variant}>{config.label}</Badge>
                        {op.risk_level === 'high' && (
                          <Badge variant="outline" className="border-destructive/40 text-destructive">
                            HÖG
                          </Badge>
                        )}
                        {op.actor_type && op.actor_type !== 'user' && (
                          <Badge variant="outline" className="text-xs">
                            <Bot className="h-3 w-3 mr-1" />
                            {op.actor_label || op.actor_type}
                          </Badge>
                        )}
                        {op.status === 'committed' && (
                          <Badge variant="success">
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                            Godkänd
                          </Badge>
                        )}
                        {op.status === 'rejected' && (
                          <Badge variant="destructive">
                            <XCircle className="h-3 w-3 mr-1" />
                            Avvisad
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(op.created_at)}
                        </span>
                      </div>
                      <p className="text-sm font-medium truncate">{op.title}</p>
                      {showHighRiskWarning && (
                        <p className="mt-1 flex items-start gap-1 text-xs text-destructive truncate">
                          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="truncate">{warningSentence}</span>
                        </p>
                      )}
                      {op.agent_metadata && (
                        <div className="mt-1">
                          <AgentContextStrip op={op} />
                        </div>
                      )}
                      {op.status === 'rejected' && op.rejection_category && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Avvisad: {REJECTION_CATEGORY_LABELS[op.rejection_category]}
                          {op.rejection_reason ? ` — "${op.rejection_reason}"` : ''}
                        </p>
                      )}
                    </div>

                    {op.status === 'pending' && (
                      <div className="flex gap-2 flex-shrink-0">
                        <Button
                          size="sm"
                          className="h-8 px-3 text-xs"
                          disabled={periodLocked}
                          title={periodLocked ? 'Perioden är låst' : undefined}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (periodLocked) return
                            setSelectedOp(op)
                            setShowCommitDialog(true)
                          }}
                        >
                          Godkänn
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 px-3 text-xs"
                          onClick={(e) => {
                            e.stopPropagation()
                            openRejectDialog(op)
                          }}
                        >
                          Avvisa
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Period-lock banner sits ABOVE the expandable preview so the
                      reviewer sees the blocker even when the card is collapsed. */}
                  {periodLocked && period && op.status === 'pending' && (
                    <div className="mt-3">
                      <PeriodLockBanner period={period} />
                    </div>
                  )}

                  {/* Expandable preview */}
                  <div className={`grid transition-all duration-200 ${isExpanded ? 'grid-rows-[1fr] mt-3' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                      <div className="border-t pt-3">
                        <OperationPreview op={op} />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Commit confirmation dialog */}
      <ConfirmationDialog
        open={showCommitDialog}
        onOpenChange={setShowCommitDialog}
        title={selectedOp?.title || 'Godkänn operation'}
        warningText={selectedOp ? singleActionWarning(selectedOp.operation_type) : ''}
        confirmLabel="Godkänn"
        isSubmitting={isCommitting}
        onConfirm={handleCommit}
      >
        {selectedOp && <OperationPreview op={selectedOp} />}
      </ConfirmationDialog>

      {/* Bulk commit confirmation dialog */}
      <ConfirmationDialog
        open={showBulkDialog}
        onOpenChange={setShowBulkDialog}
        title={`Godkänn ${selectedCount} operationer?`}
        warningText=""
        confirmLabel={`Godkänn ${selectedCount}`}
        isSubmitting={isBulkCommitting}
        onConfirm={() => handleBulkCommit(Array.from(selectedIds))}
      >
        <div className="space-y-3 text-sm">
          <p>Genom att bekräfta utförs följande:</p>
          <ul className="space-y-1 rounded-md border bg-muted/30 px-3 py-2">
            {selectedBreakdown.map(({ type, count }) => (
              <li key={type} className="flex justify-between font-mono tabular-nums">
                <span className="font-sans">{bulkActionLabel(type, count)}</span>
                <span className="text-muted-foreground">{count}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Operationerna körs i ordning. Misslyckade hoppas över och rapporteras efteråt.
          </p>
        </div>
      </ConfirmationDialog>

      {/* Reject dialog — category + free-text reason. Both optional so the user
          can still reject quickly without filling anything in. */}
      <Dialog open={rejectOp != null} onOpenChange={(open) => { if (!open) setRejectOp(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Avvisa operation</DialogTitle>
            <DialogDescription>
              {rejectOp?.title}
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
                Synlig för agenten via gnubok_get_recent_rejections — hjälper den att korrigera nästa förslag.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOp(null)} disabled={isRejecting}>
              Avbryt
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={isRejecting}>
              {isRejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Avvisa'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
