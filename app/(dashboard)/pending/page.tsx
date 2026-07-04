'use client'

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useTranslations } from 'next-intl'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DataList,
  DataListHeader,
  DataListRow,
  DataListPrimary,
  DataListMeta,
  DataListMetaSeparator,
  DataListEmpty,
  DataListLoading,
} from '@/components/ui/data-list'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
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
  ArrowLeftRight,
  Users,
  ReceiptText,
  Bot,
  BookOpen,
  ChevronDown,
  Loader2,
  Lock,
  MessageSquare,
  AlertTriangle,
} from 'lucide-react'
import type {
  PendingOperation,
  PendingOperationStatus,
  PendingOperationRejectionCategory,
} from '@/types'
import { AttachDocumentPreview } from '@/components/bookkeeping/AttachDocumentPreview'
import { MatchTransactionInvoicePreview } from '@/components/bookkeeping/MatchTransactionInvoicePreview'

const OPERATION_LABEL_KEYS: Record<string, { labelKey: string; icon: typeof ArrowLeftRight; variant: 'default' | 'secondary' | 'outline' }> = {
  categorize_transaction: { labelKey: 'type_categorize_transaction', icon: ArrowLeftRight, variant: 'default' },
  create_customer: { labelKey: 'type_create_customer', icon: Users, variant: 'secondary' },
  create_invoice: { labelKey: 'type_create_invoice', icon: ReceiptText, variant: 'outline' },
  create_transaction: { labelKey: 'type_create_transaction', icon: ArrowLeftRight, variant: 'secondary' },
  create_voucher: { labelKey: 'type_create_voucher', icon: BookOpen, variant: 'outline' },
  correct_entry: { labelKey: 'type_correct_entry', icon: BookOpen, variant: 'outline' },
  reverse_entry: { labelKey: 'type_reverse_entry', icon: BookOpen, variant: 'outline' },
  mark_invoice_paid: { labelKey: 'type_mark_invoice_paid', icon: ReceiptText, variant: 'default' },
  send_invoice: { labelKey: 'type_send_invoice', icon: ReceiptText, variant: 'outline' },
  mark_invoice_sent: { labelKey: 'type_mark_invoice_sent', icon: ReceiptText, variant: 'outline' },
  match_transaction_invoice: { labelKey: 'type_match_transaction_invoice', icon: ArrowLeftRight, variant: 'secondary' },
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

function bulkActionLabel(operationType: string, count: number, t: (key: string) => string): string {
  const fn = bulkActionDescriptions[operationType]
  if (fn) return fn(count)
  const entry = OPERATION_LABEL_KEYS[operationType]
  const fallback = entry ? t(entry.labelKey) : operationType
  return `${count} × ${fallback}`
}

// Full-sentence warning for the single-op confirmation dialog AND the inline
// list-view warning when risk is medium/high. The list-view truncates beyond
// one line; the dialog shows it in full. Order roughly low → high risk so
// reviewers scanning the source see the destructive paths grouped together.
const singleActionWarnings: Record<string, string> = {
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

type VoucherLine = {
  account_number: string
  account_name?: string | null
  debit_amount: number
  credit_amount: number
  line_description?: string | null
}

function VoucherLinesTable({ lines, currency }: { lines: VoucherLine[]; currency?: string }) {
  return (
    <div className="border-t pt-2 space-y-1">
      {lines.map((line, i) => (
        <div key={i} className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs items-baseline">
          <span className="font-mono text-muted-foreground">{line.account_number}</span>
          <span className="truncate">
            {line.account_name || line.line_description || '-'}
          </span>
          <span className="font-mono tabular-nums text-right w-24">
            {line.debit_amount > 0 ? formatCurrency(line.debit_amount, currency || 'SEK') : ''}
          </span>
          <span className="font-mono tabular-nums text-right w-24">
            {line.credit_amount > 0 ? formatCurrency(line.credit_amount, currency || 'SEK') : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

function VoucherPreview({ data }: { data: Record<string, unknown> }) {
  const lines = (data.lines as VoucherLine[]) || []
  const totalDebit = data.total_debit as number | undefined
  const totalCredit = data.total_credit as number | undefined

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <span className="text-muted-foreground">Datum</span>
        <span className="font-mono">{String(data.entry_date ?? '')}</span>
        <span className="text-muted-foreground">Beskrivning</span>
        <span className="truncate">{String(data.description ?? '')}</span>
        <span className="text-muted-foreground">Serie</span>
        <span className="font-mono">{String(data.voucher_series ?? 'A')}</span>
      </div>
      {lines.length > 0 && (
        <div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-[11px] uppercase tracking-wider text-muted-foreground pb-1">
            <span>Konto</span>
            <span>Text</span>
            <span className="text-right w-24">Debet</span>
            <span className="text-right w-24">Kredit</span>
          </div>
          <VoucherLinesTable lines={lines} />
        </div>
      )}
      {totalDebit != null && totalCredit != null && (
        <div className="border-t pt-2 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs">
          <span></span>
          <span className="text-muted-foreground">Summa</span>
          <span className="font-mono tabular-nums text-right w-24 font-medium">
            {formatCurrency(totalDebit)}
          </span>
          <span className="font-mono tabular-nums text-right w-24 font-medium">
            {formatCurrency(totalCredit)}
          </span>
        </div>
      )}
    </div>
  )
}

function CorrectEntryPreview({ data }: { data: Record<string, unknown> }) {
  const original = (data.original as {
    voucher?: string
    entry_date?: string
    description?: string
    lines?: VoucherLine[]
  }) || {}
  const correction = (data.correction as {
    total_debit?: number
    total_credit?: number
    line_count?: number
    lines?: VoucherLine[]
  }) || {}

  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          Originalverifikation V{original.voucher ?? ''}, {original.entry_date ?? ''}
        </p>
        <p className="text-xs text-muted-foreground italic mb-2">{original.description ?? ''}</p>
        {original.lines && original.lines.length > 0 && (
          <VoucherLinesTable lines={original.lines} />
        )}
      </div>
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
          Korrigerad verifikation ({correction.line_count ?? correction.lines?.length ?? 0} rader)
        </p>
        {correction.lines && correction.lines.length > 0 && (
          <VoucherLinesTable lines={correction.lines} />
        )}
        {correction.total_debit != null && (
          <div className="border-t pt-1 grid grid-cols-[auto_1fr_auto_auto] gap-x-3 text-xs mt-1">
            <span></span>
            <span className="text-muted-foreground">Summa</span>
            <span className="font-mono tabular-nums text-right w-24 font-medium">
              {formatCurrency(correction.total_debit)}
            </span>
            <span className="font-mono tabular-nums text-right w-24 font-medium">
              {formatCurrency(correction.total_credit ?? 0)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// Render a primitive (string/number/bool) or a short summary of an array/object.
// Used by GenericPreview to avoid the "[object Object]" stringification that
// occurs when an operation_type has no dedicated preview component.
function renderPrimitive(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return `${value.length} rader`
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function GenericPreview({ data }: { data: Record<string, unknown> }) {
  // Skip period_status here: it's surfaced in the dedicated banner, not the
  // generic key-value dump (otherwise the approver sees the same fact twice).
  const entries = Object.entries(data).filter(([k, v]) => v != null && v !== '' && k !== 'period_status')
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <span className="text-muted-foreground">{key.replace(/_/g, ' ')}</span>
          <span className={typeof value === 'number' ? 'font-mono tabular-nums' : ''}>
            {renderPrimitive(value)}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

function OperationPreview({ op }: { op: PendingOperation }) {
  const body = (() => {
    switch (op.operation_type) {
      case 'categorize_transaction':
        return <CategorizePreview data={op.preview_data} />
      case 'create_customer':
        return <CustomerPreview data={op.preview_data} />
      case 'create_invoice':
        return <InvoicePreview data={op.preview_data} />
      case 'create_transaction':
        return <CreateTransactionPreview data={op.preview_data} />
      case 'create_voucher':
        return <VoucherPreview data={op.preview_data} />
      case 'correct_entry':
        return <CorrectEntryPreview data={op.preview_data} />
      case 'attach_document_to_transaction':
        return <AttachDocumentPreview data={op.preview_data} params={op.params} />
      case 'match_transaction_invoice':
        return <MatchTransactionInvoicePreview data={op.preview_data} />
      default:
        return <GenericPreview data={op.preview_data} />
    }
  })()
  return body
}

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
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
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

type TabStatus = Extract<PendingOperationStatus, 'pending' | 'committed' | 'rejected'>
type StatusCounts = Record<TabStatus, number | null>

export default function PendingOperationsPage() {
  const t = useTranslations('pending')
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<PendingOperationStatus>('pending')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [conversationFilter, setConversationFilter] = useState<string | null>(null)
  const [counts, setCounts] = useState<StatusCounts>({
    pending: null,
    committed: null,
    rejected: null,
  })
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [selectedOp, setSelectedOp] = useState<PendingOperation | null>(null)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkDialog, setShowBulkDialog] = useState(false)
  const [isBulkCommitting, setIsBulkCommitting] = useState(false)
  // Reject dialog state: separate from the generic destructive-confirm so we
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
      setCounts((prev) => ({ ...prev, [activeTab]: json.count ?? json.data?.length ?? 0 }))
    } catch {
      toast({ title: 'Kunde inte ladda operationer', variant: 'destructive' })
    }
    setIsLoading(false)
  }, [activeTab, toast])

  const fetchAllCounts = useCallback(async () => {
    const statuses: TabStatus[] = ['pending', 'committed', 'rejected']
    try {
      const results = await Promise.all(
        statuses.map((s) =>
          fetch(`/api/pending-operations?status=${s}&limit=1`).then((r) => r.json())
        )
      )
      setCounts({
        pending: results[0]?.count ?? 0,
        committed: results[1]?.count ?? 0,
        rejected: results[2]?.count ?? 0,
      })
    } catch {
      // Counts are best-effort; the active tab's count will still update via fetchOperations
    }
  }, [])

  useEffect(() => {
    fetchOperations()
  }, [fetchOperations])

  useEffect(() => {
    fetchAllCounts()
  }, [fetchAllCounts])

  // Realtime subscription: refetch when ANY pending_operations row changes for
  // this company. RLS scopes the channel automatically: we don't see other
  // tenants' events. We refetch the whole list (rather than patching state
  // in-place) so server-side filtering, sorting, and computed fields stay in
  // sync with whatever the API route returned. The counts endpoint isn't
  // pushed by the same trigger, so we also refresh counts on every change.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel('pending_operations:list')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pending_operations' },
        () => {
          fetchOperations()
          fetchAllCounts()
        }
      )
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [fetchOperations, fetchAllCounts])

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
      fetchAllCounts()
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
      fetchAllCounts()
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
      fetchAllCounts()
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

  const tabLabel = (label: string, status: TabStatus) => {
    const count = counts[status]
    return count == null ? label : `${label} (${count})`
  }

  const showFilterDot = sourceFilter !== 'all'

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('subtitle')}
      />

      {conversationFilter && (
        <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as PendingOperationStatus)}>
          <TabsList>
            <TabsTrigger value="pending">{tabLabel(t('tab_pending'), 'pending')}</TabsTrigger>
            <TabsTrigger value="committed">{tabLabel(t('tab_committed'), 'committed')}</TabsTrigger>
            <TabsTrigger value="rejected">{tabLabel(t('tab_rejected'), 'rejected')}</TabsTrigger>
          </TabsList>
        </Tabs>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-2">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                Filter
              </span>
              <span>{sourceFilterLabels(t)[sourceFilter]}</span>
              {showFilterDot && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
              )}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[12rem]">
            <DropdownMenuLabel>Källa</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as SourceFilter)}
            >
              <DropdownMenuRadioItem value="all">{t('tab_all')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="agent">{t('tab_agent')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="high_risk">{t('tab_high_risk')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <DataList>
        {showBulkControls && bulkEligible.length > 0 && (
          <DataListHeader>
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all"
                checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                onCheckedChange={() => toggleSelectAll()}
                aria-label={t('select_all_aria')}
              />
              <label htmlFor="select-all" className="text-sm cursor-pointer">
                {selectedCount > 0
                  ? t('selected_count', { count: selectedCount })
                  : excludedFromBulk > 0
                    ? t('select_all_count_partial', {
                        eligible: bulkEligible.length,
                        total: pendingTotal,
                        excluded: excludedFromBulk,
                      })
                    : t('select_all_count', { count: bulkEligible.length })}
              </label>
            </div>

            {/* Only worth showing when there's more than one type to pick from:
                with a single type it just duplicates "Markera alla". */}
            {typeCounts.length >= 2 && selectedCount === 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-muted-foreground">{t('quick_pick')}</span>
                {typeCounts.map(([type, count]) => {
                  const entry = OPERATION_LABEL_KEYS[type]
                  const label = entry ? t(entry.labelKey) : type
                  return (
                    <Button
                      key={type}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => selectAllOfType(type)}
                    >
                      {label} ({count})
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
                  {t('deselect')}
                </Button>
              )}
              <Button
                size="sm"
                className="h-8 px-3 text-xs"
                disabled={selectedCount === 0 || isBulkCommitting}
                onClick={() => setShowBulkDialog(true)}
              >
                {selectedCount > 0
                  ? t('approve_selected', { count: selectedCount })
                  : t('approve_selected_none')}
              </Button>
            </div>
          </DataListHeader>
        )}

        {isLoading ? (
          <DataListLoading />
        ) : filteredOperations.length === 0 ? (
          <DataListEmpty
            icon={<ClipboardCheck className="h-6 w-6" />}
            title={
              activeTab === 'pending'
                ? t('empty_pending_title')
                : activeTab === 'committed'
                  ? t('empty_committed_title')
                  : t('empty_rejected_title')
            }
            description={
              activeTab === 'pending'
                ? t('empty_pending_description')
                : t('empty_finished_description')
            }
          />
        ) : (
          filteredOperations.map((op) => {
            const entry = OPERATION_LABEL_KEYS[op.operation_type]
            const config = entry
              ? { label: t(entry.labelKey), icon: entry.icon, variant: entry.variant }
              : { label: op.operation_type, icon: ClipboardCheck, variant: 'default' as const }
            const isExpanded = expandedId === op.id
            const period = getPeriodStatus(op)
            const periodLocked = period != null && period.status !== 'open'
            const canBulkSelect =
              showBulkControls && op.status === 'pending' && op.risk_level !== 'high' && !periodLocked
            const isSelected = selectedIds.has(op.id)
            const isAgent = op.actor_type && op.actor_type !== 'user'
            const conversationId = op.agent_metadata?.conversation_id ?? null
            const warningSentence = singleActionWarning(op.operation_type)
            const showHighRiskWarning =
              op.risk_level === 'high' && warningSentence && op.status === 'pending'

            return (
              <DataListRow
                key={op.id}
                selected={isSelected}
                expanded={isExpanded}
                onClick={() => setExpandedId(isExpanded ? null : op.id)}
                leading={
                  canBulkSelect ? (
                    <div onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleSelected(op.id)}
                        aria-label={t('select_operation_aria')}
                      />
                    </div>
                  ) : undefined
                }
                trailing={
                  op.status === 'pending' ? (
                    <>
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
                        {t('approve')}
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
                        {t('reject')}
                      </Button>
                    </>
                  ) : undefined
                }
                expandedContent={
                  <>
                    {/* Period-lock banner sits ABOVE the preview so the reviewer
                        sees the blocker as soon as they expand the row. */}
                    {periodLocked && period && op.status === 'pending' && (
                      <div className="mb-3">
                        <PeriodLockBanner period={period} />
                      </div>
                    )}
                    <OperationPreview op={op} />
                  </>
                }
              >
                <DataListPrimary>{op.title}</DataListPrimary>
                <DataListMeta>
                  <span className="font-medium text-foreground/70">{config.label}</span>
                  {isAgent && (
                    <>
                      <DataListMetaSeparator />
                      <span className="inline-flex items-center gap-1">
                        <Bot className="h-3 w-3" />
                        {/* The origin line doubles as the deep-link into the
                            originating conversation: no separate strip needed. */}
                        {conversationId ? (
                          <a
                            href={`/pending?conversation=${conversationId}`}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {originLabel(op, t) ?? op.actor_label ?? op.actor_type}
                          </a>
                        ) : (
                          originLabel(op, t) ?? op.actor_label ?? op.actor_type
                        )}
                      </span>
                    </>
                  )}
                  <DataListMetaSeparator />
                  <span>{formatRelativeTime(op.created_at)}</span>
                  {op.risk_level === 'high' && (
                    <Badge variant="destructive" className="ml-1 h-4 px-1.5 py-0 text-[10px]">
                      {t('badge_high_risk')}
                    </Badge>
                  )}
                  {isAutoExpired(op) && (
                    <Badge variant="secondary" className="ml-1 h-4 px-1.5 py-0 text-[10px]">
                      {t('badge_auto_expired')}
                    </Badge>
                  )}
                </DataListMeta>
                {showHighRiskWarning && (
                  <p className="mt-1 flex items-start gap-1 text-xs text-destructive">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>{warningSentence}</span>
                  </p>
                )}
                {op.status === 'rejected' && op.rejection_category && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Avvisad: {REJECTION_CATEGORY_LABELS[op.rejection_category]}
                    {op.rejection_reason ? `, "${op.rejection_reason}"` : ''}
                  </p>
                )}
                {/* rejection_category is always NULL on auto-expired rows, so
                    this never collides with the manual-rejection line above. */}
                {isAutoExpired(op) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('auto_expired_detail')}
                  </p>
                )}
              </DataListRow>
            )
          })
        )}
      </DataList>

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
          <ul className="space-y-1 rounded-md border bg-muted/30 px-3 py-2">
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
                Synlig för agenten via gnubok_get_recent_rejections: hjälper den att korrigera nästa förslag.
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
