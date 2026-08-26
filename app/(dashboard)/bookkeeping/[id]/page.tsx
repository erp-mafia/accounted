'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { AccountNumber } from '@/components/ui/account-number'
import { Textarea } from '@/components/ui/textarea'
import {
  Loader2,
  ArrowLeft,
  AlertTriangle,
  Lock,
  Pencil,
  Copy,
  CalendarClock,
  FileText,
  RotateCcw,
  Scissors,
  PenLine,
  Bot,
  MoreHorizontal,
  Trash2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate, cn } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { AttnLine } from '@/components/ui/attn-line'
import { HelpPopover } from '@/components/ui/help-popover'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import JournalEntryStatusBadge, { useSourceTypeLabels } from '@/components/bookkeeping/JournalEntryStatusBadge'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import CorrectOpeningBalanceDialog from '@/components/bookkeeping/CorrectOpeningBalanceDialog'
import StrikeLinesDialog from '@/components/bookkeeping/StrikeLinesDialog'
import CorrectMetadataDialog from '@/components/bookkeeping/CorrectMetadataDialog'
import EditDraftEntryDialog from '@/components/bookkeeping/EditDraftEntryDialog'
import RecordateEntryDialog from '@/components/bookkeeping/RecordateEntryDialog'
import CorrectionChain from '@/components/bookkeeping/CorrectionChain'
import RetagLineDialog, { type RetagLine } from '@/components/dimensions/RetagLineDialog'
import { useCompanySettings } from '@/components/settings/useSettings'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useDimensions } from '@/lib/reference-data/hooks'
import { DetailPager } from '@/components/common/DetailPager'
import { listContextKey } from '@/lib/navigation/list-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { JournalEntry, JournalEntryLine } from '@/types'
import type { UnderlagReference } from '@/lib/core/bookkeeping/journal-entry-references'

// Snapshot of a struck line, as stored in journal_entry_rattelse_log.
type StruckLineSnapshot = {
  id: string
  account_number: string
  debit_amount: number | string
  credit_amount: number | string
  line_description: string | null
  sort_order: number
}

type RattelseLogRow = {
  id: string
  rattelse_type: 'metadata' | 'lines'
  old_description: string | null
  new_description: string | null
  old_entry_date: string | null
  new_entry_date: string | null
  struck_lines: StruckLineSnapshot[] | null
  added_lines: StruckLineSnapshot[] | null
  actor: string | null
  created_at: string
}

/**
 * Human "who committed this" line from the committed_actor_* snapshot
 * (WHO relayed the commit; commit_method records HOW). The claude.ai MCP
 * connector mints a gnubok_sk_ API key, so MCP traffic arrives as
 * actor_type='api_key' with the key name as the label.
 */
function committedByLabel(
  actorType: string,
  actorLabel: string | null,
  t: (key: string, values?: Record<string, string>) => string,
): string {
  switch (actorType) {
    case 'user':
      return actorLabel || t('committed_by_user')
    case 'api_key':
    case 'mcp_oauth':
      return actorLabel ? t('committed_by_ai', { label: actorLabel }) : t('committed_by_ai_plain')
    case 'agent_chat':
      return t('committed_by_agent_chat')
    case 'cron':
      return t('committed_by_cron')
    case 'system':
      return t('committed_by_system')
    default:
      return actorType
  }
}

// Ledger amounts render as plain sv-SE numbers with two decimals (no currency
// suffix), the same way the verifikat list's line tables do.
const fmtAmount = (value: number | string): string =>
  Number(value).toLocaleString('sv-SE', { minimumFractionDigits: 2 })

export default function JournalEntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const company = useCompanyOptional()?.company ?? null
  const { toast } = useToast()
  const t = useTranslations('journal_detail')
  const tCommon = useTranslations('common')
  const tCorrection = useTranslations('journal_correction')
  const sourceTypeLabels = useSourceTypeLabels()
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [chain, setChain] = useState<JournalEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCorrection, setShowCorrection] = useState(false)
  const [showCorrectIB, setShowCorrectIB] = useState(false)
  const [showStrikeLines, setShowStrikeLines] = useState(false)
  const [showCorrectMetadata, setShowCorrectMetadata] = useState(false)
  const [rattelseLog, setRattelseLog] = useState<RattelseLogRow[]>([])
  const [showEdit, setShowEdit] = useState(false)
  const [showRecordate, setShowRecordate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showReverseConfirm, setShowReverseConfirm] = useState(false)
  const [isReversing, setIsReversing] = useState(false)
  // Non-null when the server refused the storno with CORRECTION_CHAIN_TOO_DEEP:
  // holds the reported chain depth and opens the bypass confirm ("Återför ändå").
  const [reverseDeepChainDepth, setReverseDeepChainDepth] = useState<number | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  // Confirm-before-posting (convention 10). The list already gates this exact
  // action; the detail page used to fire the commit straight from the button.
  const [showCommitConfirm, setShowCommitConfirm] = useState(false)
  const [commitVoucherPreview, setCommitVoucherPreview] = useState<string | null>(null)
  const [isLastInSeries, setIsLastInSeries] = useState(false)
  const [attachmentCount, setAttachmentCount] = useState(0)
  const [references, setReferences] = useState<UnderlagReference[]>([])
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  // Dimension registry, fetched once when any line carries a dimensions map:
  // used to resolve display names for the per-line dimension text ('KS: Butik');
  // it falls back to raw codes when the fetch fails or a code is unregistered.
  // Dimension names for tagged lines, from the session-cached registry
  // (lib/reference-data); null until it is there, raw codes render meanwhile.
  const { dimensions } = useDimensions()
  const registryDims = dimensions.length > 0 ? dimensions : null
  // Tier-2 retro-tagging (dimensions plan PR6): pencil on posted lines opens
  // the audited retag dialog; the log renders as a history section below.
  // Both render only when dimensions are enabled for the company.
  const { settings } = useCompanySettings()
  const dimensionsEnabled = settings?.dimensions_enabled === true
  const [retagLine, setRetagLine] = useState<RetagLine | null>(null)
  const [retagLog, setRetagLog] = useState<
    { id: string; line_id: string; old_dimensions: Record<string, string>; new_dimensions: Record<string, string>; reason: string; created_at: string }[]
  >([])

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [chainRes, refsRes, retagRes, rattelseRes] = await Promise.all([
        fetch(`/api/bookkeeping/journal-entries/${id}/chain`),
        fetch(`/api/bookkeeping/journal-entries/${id}/references`),
        fetch(`/api/bookkeeping/journal-entries/${id}/retag-log`),
        fetch(`/api/bookkeeping/journal-entries/${id}/rattelse-log`),
      ])
      if (retagRes.ok) {
        const retagPayload = await retagRes.json()
        setRetagLog(Array.isArray(retagPayload.data) ? retagPayload.data : [])
      }
      if (rattelseRes.ok) {
        const rattelsePayload = await rattelseRes.json()
        setRattelseLog(Array.isArray(rattelsePayload.data) ? rattelsePayload.data : [])
      }
      if (!chainRes.ok) {
        const { error: msg } = await chainRes.json()
        setError(msg || t('error_load_failed'))
        return
      }
      const { data } = await chainRes.json()
      setEntry(data.entry)
      setChain(data.chain)
      setIsLastInSeries(data.is_last_in_series ?? false)
      // Underlag references (linked invoices), best-effort; the verifikat still
      // renders if this fails, it just falls back to documents-only.
      if (refsRes.ok) {
        const { data: refData } = await refsRes.json()
        setReferences(refData?.references ?? [])
      } else {
        setReferences([])
      }
    } catch {
      setError(t('error_load_failed'))
    } finally {
      setIsLoading(false)
    }
  }, [id, t])

  const saveNotes = useCallback(async (value: string) => {
    setSavingNotes(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: value || null }),
      })
      if (res.ok) {
        setEntry(prev => prev ? { ...prev, notes: value || null } : prev)
        setEditingNotes(false)
      } else {
        toast({ title: t('toast_save_note_failed'), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_save_note_failed'), variant: 'destructive' })
    } finally {
      setSavingNotes(false)
    }
  }, [id, toast, t])

  // Open the confirm dialog and fetch the predicted voucher number. The
  // prediction is indicative (numbers are assigned atomically at commit); the
  // success toast always shows the real one. Mirrors JournalEntryList.
  const openCommitConfirm = useCallback(() => {
    setShowCommitConfirm(true)
    setCommitVoucherPreview(null)
    fetch('/api/bookkeeping/voucher-sequences/next')
      .then((r) => r.json())
      .then(({ data }) => {
        if (data?.next != null) setCommitVoucherPreview(`${data.series}${data.next}`)
      })
      .catch(() => {})
  }, [])

  const handleCommit = useCallback(async () => {
    setIsCommitting(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/commit`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const posted = result.data
        toast({
          title: t('toast_posted_title'),
          description: t('toast_posted_description', { voucher: formatVoucher(posted ?? {}) }),
        })
        await fetchData()
      } else {
        toast({ title: t('toast_post_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setIsCommitting(false)
    }
  }, [id, toast, fetchData, t])

  const handleDelete = useCallback(async () => {
    setIsDeleting(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}`, { method: 'DELETE' })
      const result = await res.json()
      if (res.ok) {
        const wasDraft = result.data?.was_draft === true
        toast({
          title: wasDraft ? t('toast_delete_draft_title') : t('toast_delete_entry_title'),
          description: wasDraft
            ? t('toast_delete_draft_description')
            : t('toast_delete_entry_description', { voucher: formatVoucher(result.data ?? {}) }),
        })
        router.push('/bookkeeping')
      } else {
        toast({ title: t('toast_delete_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
        setShowDeleteConfirm(false)
      }
    } catch {
      toast({ title: t('toast_delete_failed_generic'), variant: 'destructive' })
      setShowDeleteConfirm(false)
    } finally {
      setIsDeleting(false)
    }
  }, [id, router, toast, t])

  // Pure reversal (storno): cancels the verifikat with a stornoverifikation and
  // no replacement, per BFL 5 kap 5§. Distinct from "Rätta", which always books
  // a replacement entry. Routes through the engine's reverseEntry (storno +
  // reverses_id link; original → 'reversed', never deleted).
  const handleReverse = useCallback(async (allowDeepChain = false) => {
    setIsReversing(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/reverse`, {
        method: 'POST',
        ...(allowDeepChain
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allow_deep_chain: true }),
            }
          : {}),
      })
      const result = await res.json()
      if (res.ok) {
        const storno = result.data
        toast({
          title: t('toast_reverse_done_title'),
          description: t('toast_reverse_done_description', { voucher: formatVoucher(storno ?? {}) }),
        })
        setShowReverseConfirm(false)
        setReverseDeepChainDepth(null)
        await fetchData()
      } else if (result?.error?.code === 'CORRECTION_CHAIN_TOO_DEEP') {
        // Chain-depth guard: swap into the bypass confirm instead of a
        // dead-end toast. "Återför ändå" resubmits with allow_deep_chain.
        setShowReverseConfirm(false)
        setReverseDeepChainDepth(result.error?.details?.depth ?? 3)
      } else {
        toast({ title: t('toast_reverse_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_reverse_failed'), variant: 'destructive' })
    } finally {
      setIsReversing(false)
    }
  }, [id, toast, fetchData, t])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      </div>
    )
  }

  if (error || !entry) {
    return (
      <div className="space-y-8">
        <Link
          href="/bookkeeping"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <p className="py-12 text-center text-sm text-muted-foreground">{error || t('error_not_found')}</p>
      </div>
    )
  }

  const lines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
  const totalCredit = lines.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0)

  const foreignLines = lines.filter(l => l.currency && l.currency !== 'SEK' && l.amount_in_currency != null)
  const hasForeignCurrency = foreignLines.length > 0
  // For the summary: use the first foreign line's data (the settlement line)
  const foreignCurrency = hasForeignCurrency ? foreignLines[0].currency! : null
  const foreignTotal = hasForeignCurrency ? Math.abs(Number(foreignLines[0].amount_in_currency) || 0) : 0
  const foreignExchangeRate = hasForeignCurrency ? (Number(foreignLines[0].exchange_rate) || null) : null

  // A correction is itself a regular posted verifikation and can be corrected
  // again (BFL 5 kap. 5 §, the chain just grows). Storno entries are pure
  // reversals and cannot be corrected directly; the user walks to the latest
  // correction (or the original) and corrects that one.
  const canCorrect = entry.status === 'posted' && entry.source_type !== 'storno'

  // Inline rättelse (strike lines in the same verifikat) keeps structural
  // entry types on their dedicated flows: storno mirrors its original, IB
  // feeds opening_balance_entry_id, year-end feeds dispositions. The RPC
  // enforces the same rule server-side; this just hides the dead menu item.
  const canInlineRattelse =
    entry.status === 'posted' &&
    !['storno', 'opening_balance', 'year_end', 'vat_settlement'].includes(entry.source_type)

  // Struck lines (from the immutable rättelse log) render inline in the
  // lines table with strikethrough, Fortnox-style: the original stays
  // visible per BFL 5 kap 5 § even though it no longer counts.
  const struckDisplayLines = rattelseLog
    .filter((r) => r.rattelse_type === 'lines')
    .flatMap((r) =>
      (r.struck_lines ?? []).map((s) => ({ ...s, struck_at: r.created_at }))
    )

  // Live and struck lines interleaved by original position.
  const displayRows: Array<
    | { kind: 'live'; line: JournalEntryLine }
    | { kind: 'struck'; line: StruckLineSnapshot & { struck_at: string } }
  > = [
    ...lines.map((l) => ({ kind: 'live' as const, line: l })),
    ...struckDisplayLines.map((s) => ({ kind: 'struck' as const, line: s })),
  ].sort(
    (a, b) =>
      (a.line.sort_order ?? 0) - (b.line.sort_order ?? 0) ||
      // On a sort_order tie the struck original renders above its replacement.
      (a.kind === 'struck' ? -1 : 0) - (b.kind === 'struck' ? -1 : 0)
  )

  // An opening-balance verifikat must be corrected through the IB-aware flow
  // (storno + rebook + relink the period's opening_balance_entry_id), never the
  // generic "Rätta rader": that books a `correction` entry but leaves the
  // period pointing at the stornoed IB, so the Balansrapport "Ingående balans"
  // column goes stale. Only surface it on the *active* IB (posted; stornoed
  // predecessors are `reversed`, so exactly one posted IB exists per period).
  const isOpeningBalance = entry.source_type === 'opening_balance' && entry.status === 'posted'

  // Include current entry in the chain for the visualization
  const fullChain = [entry, ...chain]

  // SIE dimension prefixes. 'KS' is the market-standard abbreviation for
  // kostnadsställe; projekt has no standard abbreviation (Fortnox/Visma show
  // the dimension name, and 'PR' collides with prisnivå in some BAS setups,
  // flagged in the #859 compliance review), so dim 6 falls through to the
  // registry name below. Stays Swedish per .claude/rules/i18n.md.
  const DIM_BADGE_PREFIX: Record<string, string> = { '1': 'KS' }

  // Display-only dimension text for a line (e.g. 'KS: Butik · Projekt: P001').
  // Names resolve through the registry when loaded; raw codes otherwise.
  // Muted text, not chips: dimensions are normal data on a line, and chips
  // mark exceptions only.
  const renderDimensions = (line: JournalEntryLine) => {
    const entries = Object.entries(line.dimensions ?? {})
      .filter(([, code]) => code)
      .sort(([a], [b]) => Number(a) - Number(b))
    if (entries.length === 0) return null
    const text = entries
      .map(([dimNo, code]) => {
        const dim = registryDims?.find((d) => String(d.sie_dim_no) === dimNo)
        const value = dim?.values.find((v) => v.code === code)
        const prefix = DIM_BADGE_PREFIX[dimNo] ?? dim?.name ?? `Dim ${dimNo}`
        const hasName = !!value && value.name !== '' && value.name !== value.code
        return `${prefix}: ${hasName ? value.name : code}`
      })
      .join(' · ')
    return (
      // data-ph-mask: dimension names and codes are user data. No title
      // attribute: replay masking covers text nodes, not attributes, so
      // a title tooltip would ship the masked content in the clear.
      <span data-ph-mask="" className="block text-xs text-muted-foreground">
        {text}
      </span>
    )
  }

  const retagButton = (line: JournalEntryLine) =>
    dimensionsEnabled && canWrite && entry.status === 'posted' ? (
      <button
        type="button"
        onClick={() => setRetagLine(line as unknown as RetagLine)}
        className="rounded-sm p-1 text-muted-foreground/50 transition-colors hover:bg-secondary/60 hover:text-foreground"
        aria-label="Ändra dimensioner"
        title="Ändra dimensioner (påverkar endast internredovisningen)"
      >
        <Pencil className="h-3 w-3" />
      </button>
    ) : null

  // Title in the serif: the voucher label for posted entries, a plain
  // "Utkast till verifikat" while the number is still unassigned.
  const title = entry.status === 'draft' ? t('title_draft') : t('title', { label: formatVoucher(entry) })

  const metaParts = [
    formatDate(entry.entry_date),
    entry.description,
    entry.committed_at ? t('posted_on', { date: formatDate(entry.committed_at) }) : null,
  ].filter(Boolean)

  // Header actions (convention 9): the one next step as a filled button, at
  // most a couple of quiet secondaries, everything else in the ⋯ menu. The
  // old surface offered no actions at all on reversed/cancelled entries; keep
  // that gate.
  const showActions = entry.status === 'posted' || entry.status === 'draft'
  const showDelete = entry.status === 'draft' || isLastInSeries
  const showRattelseGroup = canCorrect && !isOpeningBalance

  const underlagAside = (() => {
    if (attachmentCount === 0 && references.length === 0) {
      return <AttnLine>{t('no_attachments')}</AttnLine>
    }
    const parts = [
      attachmentCount > 0 ? t('attachments_count', { count: attachmentCount }) : null,
      references.length > 0 ? t('references_count', { count: references.length }) : null,
    ].filter(Boolean)
    return <span className="text-[11px] tabular-nums text-muted-foreground">{parts.join(' · ')}</span>
  })()

  return (
    <div className="space-y-8 stagger-enter">
      {/* Back link + prev/next record pager */}
      <div className="flex items-center justify-between gap-4">
        <Link
          href="/bookkeeping"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <DetailPager
          contextKey={listContextKey('bookkeeping', company?.id)}
          basePath="/bookkeeping"
          currentId={id}
          // Arrow paging unmounts the page and would destroy an unsaved notes
          // draft; the textarea only guards arrows while it has focus, so gate
          // the keyboard bindings on the editing state itself.
          keyboard={!editingNotes}
        />
      </div>

      {/* Header: serif title, status chips only for deviations (a plain posted
          verifikat carries none), a quiet meta line, the next step right. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            {/* data-ph-mask: the title carries the voucher number */}
            <h1 data-ph-mask="" className="font-display text-2xl leading-8 tracking-tight">{title}</h1>
            <JournalEntryStatusBadge entry={entry} showStatus={entry.status !== 'posted'} />
            {rattelseLog.length > 0 && (
              <Badge variant="outline" title={t('rattelse_history_title')}>
                Rättad
              </Badge>
            )}
          </div>
          {/* data-ph-mask: the meta line carries the entry description */}
          <p data-ph-mask="" className="mt-1 text-sm text-muted-foreground">{metaParts.join(' · ')}</p>
        </div>

        {showActions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {entry.status === 'draft' && (
              <Button
                variant="outline"
                onClick={() => setShowEdit(true)}
                disabled={!canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : <Pencil className="mr-2 h-4 w-4" />}
                {t('edit_draft')}
              </Button>
            )}
            {entry.status === 'draft' && (
              <Button
                onClick={openCommitConfirm}
                disabled={!canWrite || isCommitting}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : isCommitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('post')}
              </Button>
            )}
            {canCorrect && isOpeningBalance && (
              <Button
                variant="outline"
                onClick={() => setShowCorrectIB(true)}
                disabled={!canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : <Pencil className="mr-2 h-4 w-4" />}
                {t('correct_opening_balances')}
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={tCommon('more_options')}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[240px]">
                {/* Copy is not status-gated: it only prefills a fresh manual
                    draft (no voucher number, date or attachments carried over),
                    so it is offered on drafts too, matching the list surfaces. */}
                <DropdownMenuItem asChild disabled={!canWrite}>
                  <Link href={`/bookkeeping?copy_from=${entry.id}`}>
                    <Copy className="h-4 w-4" />
                    {t('copy_entry')}
                  </Link>
                </DropdownMenuItem>
                {showRattelseGroup && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>{t('correct_menu')}</DropdownMenuLabel>
                    {canInlineRattelse && (
                      <DropdownMenuItem onSelect={() => setShowStrikeLines(true)} disabled={!canWrite}>
                        <Scissors className="h-4 w-4" />
                        {t('strike_lines')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setShowCorrectMetadata(true)} disabled={!canWrite}>
                      <PenLine className="h-4 w-4" />
                      {t('correct_metadata')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowCorrection(true)} disabled={!canWrite}>
                      <Pencil className="h-4 w-4" />
                      {t('correct_lines')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setShowRecordate(true)} disabled={!canWrite}>
                      <CalendarClock className="h-4 w-4" />
                      {t('correct_date')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setShowReverseConfirm(true)} disabled={!canWrite}>
                      <RotateCcw className="h-4 w-4" />
                      {t('reverse_action')}
                    </DropdownMenuItem>
                  </>
                )}
                {showDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => setShowDeleteConfirm(true)}
                      disabled={!canWrite}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      {entry.status === 'draft' ? t('delete_draft') : t('delete_entry')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* Facts on the left, the internal note on the right. */}
      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-2">
        <DetailSection kicker={t('details_title')}>
          <DefRow label={t('field_voucher')}>
            {entry.status === 'draft' ? <DefEmpty /> : <span className="tabular-nums">{formatVoucher(entry)}</span>}
          </DefRow>
          <DefRow label={t('field_date')}>
            <span className="tabular-nums">{formatDate(entry.entry_date)}</span>
          </DefRow>
          <DefRow label={t('field_type')}>{sourceTypeLabels[entry.source_type] || entry.source_type}</DefRow>
          {entry.source_voucher_series && entry.source_voucher_number != null && (
            <DefRow label={t('field_source_voucher')}>
              <span className="tabular-nums">
                {formatVoucher({ voucher_series: entry.source_voucher_series, voucher_number: entry.source_voucher_number })}
              </span>
            </DefRow>
          )}
          {entry.committed_at && (
            <DefRow label={t('field_posted_at')}>
              <span className="tabular-nums">{formatDate(entry.committed_at)}</span>
            </DefRow>
          )}
          {entry.committed_at && entry.committed_actor_type && (
            <DefRow label={t('field_committed_by')}>
              <span className="inline-flex items-center gap-1">
                {entry.committed_actor_type !== 'user' && <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />}
                {committedByLabel(entry.committed_actor_type, entry.committed_actor_label, t)}
              </span>
            </DefRow>
          )}
          {/* Foreign-currency conversion audit: rate and original amount from
              the settlement line, as plain facts beside the other details. */}
          {hasForeignCurrency && foreignCurrency && (
            <>
              <DefRow label={t('currency_rate')}>
                <span className="tabular-nums">
                  {foreignExchangeRate
                    ? `1 ${foreignCurrency} = ${foreignExchangeRate.toLocaleString('sv-SE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SEK`
                    : '-'}
                </span>
              </DefRow>
              <DefRow label={t('currency_original_amount')}>
                <span className="tabular-nums">{fmtAmount(foreignTotal)} {foreignCurrency}</span>
              </DefRow>
            </>
          )}
        </DetailSection>

        {/* Notes: always editable (internal metadata, not BFL verifikation content) */}
        <DetailSection
          kicker={t('field_note')}
          aside={
            !editingNotes && canWrite ? (
              <button
                type="button"
                onClick={() => { setNotesValue(entry.notes || ''); setEditingNotes(true) }}
                aria-label={t('edit_note_aria')}
                className="text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
              >
                {tCommon('edit')}
              </button>
            ) : undefined
          }
        >
          {editingNotes ? (
            <div className="space-y-2">
              <Textarea
                value={notesValue}
                onChange={(e) => setNotesValue(e.target.value)}
                placeholder={t('note_placeholder')}
                className="resize-none text-sm"
                rows={3}
                maxLength={2000}
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditingNotes(false)}
                  disabled={savingNotes}
                >
                  {tCommon('cancel')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveNotes(notesValue)}
                  disabled={savingNotes}
                >
                  {savingNotes && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {tCommon('save')}
                </Button>
              </div>
            </div>
          ) : entry.notes ? (
            <p className="py-2 text-sm whitespace-pre-wrap">{entry.notes}</p>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">{t('no_note')}</p>
          )}
        </DetailSection>
      </div>

      {/* Lines: the list-page table idiom straight on the panel. */}
      <DetailSection
        kicker={t('lines_title')}
        aside={
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {t('lines_count', { count: lines.length })}
          </span>
        }
      >
        <table className="hidden w-full border-collapse text-[13px] sm:table">
          <thead>
            <tr>
              <th className={cn(TH_CLASS, 'pl-0')}>{t('col_account')}</th>
              <th className={TH_CLASS}>{t('col_description')}</th>
              <th className={cn(TH_CLASS, 'text-right')}>{t('col_debit')}</th>
              <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('col_credit')}</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row) => {
              if (row.kind === 'struck') {
                const s = row.line
                return (
                  <tr key={`struck-${s.id}`} className="text-muted-foreground">
                    <td className={cn(TD_CLASS, 'pl-0 whitespace-nowrap line-through decoration-muted-foreground/70')}>
                      <AccountNumber number={s.account_number} showName />
                    </td>
                    <td className={TD_CLASS}>
                      <span className="line-through decoration-muted-foreground/70">
                        {s.line_description || ''}
                      </span>
                      <span className="ml-2 text-xs">
                        {t('struck_marker', { date: formatDate(s.struck_at) })}
                      </span>
                    </td>
                    <td className={cn(TD_CLASS, 'text-right tabular-nums whitespace-nowrap line-through decoration-muted-foreground/70')}>
                      {Number(s.debit_amount) > 0 && fmtAmount(s.debit_amount)}
                    </td>
                    <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums whitespace-nowrap line-through decoration-muted-foreground/70')}>
                      {Number(s.credit_amount) > 0 && fmtAmount(s.credit_amount)}
                    </td>
                  </tr>
                )
              }
              const line = row.line
              const lineHasForeignCurrency = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
              return (
                <tr key={line.id}>
                  <td className={cn(TD_CLASS, 'pl-0 whitespace-nowrap')}>
                    <AccountNumber number={line.account_number} showName />
                  </td>
                  <td className={cn(TD_CLASS, 'text-muted-foreground')}>
                    <span className="inline-flex items-center gap-1">
                      {line.line_description || ''}
                      {retagButton(line)}
                    </span>
                    {renderDimensions(line)}
                  </td>
                  <td className={cn(TD_CLASS, 'text-right tabular-nums whitespace-nowrap')}>
                    {Number(line.debit_amount) > 0 && (
                      <>
                        {fmtAmount(line.debit_amount)}
                        {lineHasForeignCurrency && (
                          <span className="block text-xs text-muted-foreground">
                            {fmtAmount(line.amount_in_currency!)} {line.currency}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums whitespace-nowrap')}>
                    {Number(line.credit_amount) > 0 && (
                      <>
                        {fmtAmount(line.credit_amount)}
                        {lineHasForeignCurrency && (
                          <span className="block text-xs text-muted-foreground">
                            {fmtAmount(line.amount_in_currency!)} {line.currency}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="font-medium">
              <td colSpan={2} className="pl-0 pr-4 pt-3">{t('sum')}</td>
              <td className="px-4 pt-3 text-right tabular-nums">{fmtAmount(totalDebit)}</td>
              <td className="pl-4 pr-0 pt-3 text-right tabular-nums">{fmtAmount(totalCredit)}</td>
            </tr>
          </tfoot>
        </table>

        {/* Mobile: one flat row per line, no numeric columns to cram. */}
        <div className="divide-y divide-border text-sm sm:hidden">
          {displayRows.map((row) => {
            if (row.kind === 'struck') {
              const s = row.line
              return (
                <div key={`struck-${s.id}`} className="flex items-start justify-between gap-4 py-3 text-muted-foreground">
                  <div className="min-w-0 flex-1">
                    <div className="line-through decoration-muted-foreground/70">
                      <AccountNumber number={s.account_number} showName />
                    </div>
                    {s.line_description && (
                      <p className="truncate text-xs line-through decoration-muted-foreground/70">{s.line_description}</p>
                    )}
                    <p className="text-xs">{t('struck_marker', { date: formatDate(s.struck_at) })}</p>
                  </div>
                  <div className="shrink-0 text-right tabular-nums line-through decoration-muted-foreground/70">
                    {Number(s.debit_amount) > 0 && <p>{fmtAmount(s.debit_amount)} D</p>}
                    {Number(s.credit_amount) > 0 && <p>{fmtAmount(s.credit_amount)} K</p>}
                  </div>
                </div>
              )
            }
            const line = row.line
            const lineHasForeignCurrency = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
            return (
              <div key={line.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <AccountNumber number={line.account_number} showName />
                    {retagButton(line)}
                  </div>
                  {line.line_description && (
                    <p className="truncate text-xs text-muted-foreground">{line.line_description}</p>
                  )}
                  {renderDimensions(line)}
                </div>
                <div className="shrink-0 text-right tabular-nums">
                  {Number(line.debit_amount) > 0 && (
                    <p>
                      {fmtAmount(line.debit_amount)} D
                      {lineHasForeignCurrency && (
                        <span className="block text-xs text-muted-foreground">
                          {fmtAmount(line.amount_in_currency!)} {line.currency}
                        </span>
                      )}
                    </p>
                  )}
                  {Number(line.credit_amount) > 0 && (
                    <p>
                      {fmtAmount(line.credit_amount)} K
                      {lineHasForeignCurrency && (
                        <span className="block text-xs text-muted-foreground">
                          {fmtAmount(line.amount_in_currency!)} {line.currency}
                        </span>
                      )}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
          <div className="flex items-start justify-between gap-4 py-3 font-medium">
            <span>{t('sum')}</span>
            <div className="text-right tabular-nums">
              <p>{t('summary_debit')} {fmtAmount(totalDebit)}</p>
              <p>{t('summary_credit')} {fmtAmount(totalCredit)}</p>
            </div>
          </div>
        </div>
      </DetailSection>

      {/* Underlag: linked invoices as rows, then the document list. */}
      <DetailSection kicker={t('attachments_title')} aside={underlagAside}>
        {references.length > 0 && (
          <DefRow label={t('references_title')} className="items-baseline">
            <ul className="divide-y divide-border">
              {references.map((ref) => (
                <li key={`${ref.type}-${ref.id}`} className="py-1 first:pt-0 last:pb-0">
                  <Link
                    href={ref.type === 'invoice' ? `/invoices/${ref.id}` : `/supplier-invoices/${ref.id}`}
                    className="inline-flex items-center gap-2 hover:underline"
                  >
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {ref.type === 'invoice'
                        ? t('reference_invoice', { number: ref.number })
                        : t('reference_supplier_invoice', { number: ref.number })}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </DefRow>
        )}
        <JournalEntryAttachments
          journalEntryId={entry.id}
          onCountChange={setAttachmentCount}
          variant="section"
        />
      </DetailSection>

      {/* Correction chain (storno/rättelse pairs). The explanatory copy sits
          behind the kicker's "?" instead of an always-visible info box. */}
      {chain.length > 0 && (
        <DetailSection
          kicker={t('history_title')}
          help={
            <HelpPopover>
              <p>{tCorrection('info')}</p>
            </HelpPopover>
          }
        >
          <CorrectionChain currentEntryId={id} chain={fullChain} />
        </DetailSection>
      )}

      {/* Rättelsehistorik (BFL 5 kap 5 § / 9 §): the immutable who/when trail
          behind inline rättelser. Stays Swedish (voucher detail surface). */}
      {rattelseLog.length > 0 && (
        <DetailSection kicker={t('rattelse_history_title')}>
          <ul className="divide-y divide-border text-sm">
            {rattelseLog.map((row) => (
              <li key={row.id} className="py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="tabular-nums text-muted-foreground">{formatDate(row.created_at)}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.rattelse_type === 'metadata' ? t('rattelse_kind_metadata') : t('rattelse_kind_lines')}
                  </span>
                </div>
                {row.rattelse_type === 'metadata' ? (
                  <div className="space-y-1">
                    {row.old_description !== row.new_description && (
                      <p>
                        <span className="text-muted-foreground line-through">{row.old_description}</span>
                        {' → '}
                        <span>{row.new_description}</span>
                      </p>
                    )}
                    {row.old_entry_date !== row.new_entry_date && (
                      <p className="tabular-nums">
                        <span className="text-muted-foreground line-through">{formatDate(row.old_entry_date || '')}</span>
                        {' → '}
                        <span>{formatDate(row.new_entry_date || '')}</span>
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {(row.struck_lines ?? []).map((s) => (
                      <p key={s.id} className="tabular-nums text-muted-foreground">
                        <span className="line-through decoration-muted-foreground/70">
                          {s.account_number}
                          {' '}
                          {Number(s.debit_amount) > 0
                            ? `${fmtAmount(s.debit_amount)} D`
                            : `${fmtAmount(s.credit_amount)} K`}
                        </span>
                      </p>
                    ))}
                    {(row.added_lines ?? []).map((a) => (
                      <p key={a.id} className="tabular-nums">
                        {a.account_number}
                        {' '}
                        {Number(a.debit_amount) > 0
                          ? `${fmtAmount(a.debit_amount)} D`
                          : `${fmtAmount(a.credit_amount)} K`}
                      </p>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </DetailSection>
      )}

      {/* Dimension retag history (dimensions plan PR6): the immutable
          before/after trail. Stays Swedish (voucher detail surface). */}
      {dimensionsEnabled && retagLog.length > 0 && (
        <DetailSection kicker="Ändringshistorik för dimensioner">
          <ul className="divide-y divide-border text-sm">
            {retagLog.map((row) => {
              const lineForRow = lines.find((l) => l.id === row.line_id)
              const fmt = (dims: Record<string, string>) => {
                const entries = Object.entries(dims ?? {}).sort(([a], [b]) => Number(a) - Number(b))
                return entries.length > 0 ? entries.map(([no, code]) => `${no}: ${code}`).join(', ') : '-'
              }
              return (
                <li key={row.id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="tabular-nums text-muted-foreground">{formatDate(row.created_at)}</span>
                    {lineForRow && <AccountNumber number={lineForRow.account_number} />}
                  </div>
                  <p className="tabular-nums">
                    <span className="text-muted-foreground line-through">{fmt(row.old_dimensions)}</span>
                    {' → '}
                    <span>{fmt(row.new_dimensions)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{row.reason}</p>
                </li>
              )
            })}
          </ul>
        </DetailSection>
      )}

      {/* Retag dialog (Tier-2 retro-tagging) */}
      <RetagLineDialog
        open={retagLine !== null}
        onOpenChange={(open) => {
          if (!open) setRetagLine(null)
        }}
        line={retagLine}
        onRetagged={fetchData}
      />

      {/* Inline rättelse dialogs (strike lines / metadata) */}
      {showStrikeLines && entry && (
        <StrikeLinesDialog
          entry={entry}
          open={showStrikeLines}
          onOpenChange={setShowStrikeLines}
          onCorrected={() => {
            setShowStrikeLines(false)
            fetchData()
          }}
        />
      )}
      {showCorrectMetadata && entry && (
        <CorrectMetadataDialog
          entry={entry}
          open={showCorrectMetadata}
          onOpenChange={setShowCorrectMetadata}
          onCorrected={() => {
            setShowCorrectMetadata(false)
            fetchData()
          }}
        />
      )}

      {/* Correction dialog */}
      {showCorrection && entry && (
        <CorrectionEntryDialog
          entry={entry}
          open={showCorrection}
          onOpenChange={setShowCorrection}
          onCorrected={() => {
            setShowCorrection(false)
            fetchData()
          }}
        />
      )}

      {/* Opening-balance correction dialog: IB-aware (storno + rebook + relink) */}
      {showCorrectIB && entry && (
        <CorrectOpeningBalanceDialog
          entry={entry}
          open={showCorrectIB}
          onOpenChange={setShowCorrectIB}
          onCorrected={() => {
            setShowCorrectIB(false)
            fetchData()
          }}
        />
      )}

      {/* Recordate (move to correct date) dialog */}
      {showRecordate && entry && (
        <RecordateEntryDialog
          entry={entry}
          open={showRecordate}
          onOpenChange={setShowRecordate}
          onMoved={() => {
            setShowRecordate(false)
            fetchData()
          }}
        />
      )}

      {/* Edit draft dialog: drafts only; PATCHes the entry in place */}
      {showEdit && entry && entry.status === 'draft' && (
        <EditDraftEntryDialog
          entry={entry}
          open={showEdit}
          onOpenChange={setShowEdit}
          onUpdated={() => {
            setShowEdit(false)
            fetchData()
          }}
        />
      )}

      {/* Confirm-before-posting for drafts (convention 10): describes the
          outcome ("Bokförs som A-218 ...") before the commit runs, matching
          the same action on the list. */}
      <ConfirmDialog
        open={showCommitConfirm}
        onOpenChange={setShowCommitConfirm}
        title={t('confirm_post_title')}
        description={
          commitVoucherPreview
            ? t('confirm_post_description', {
                voucher: commitVoucherPreview,
                description: entry?.description || '',
                amount: formatCurrency(totalDebit),
              })
            : t('confirm_post_description_generic', { description: entry?.description || '' })
        }
        confirmLabel={t('post')}
        onConfirm={handleCommit}
      />

      {/* Delete confirmation dialog */}
      <ConfirmationDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        onConfirm={handleDelete}
        isSubmitting={isDeleting}
        title={entry?.status === 'draft' ? t('delete_draft') : t('delete_entry')}
        warningText={
          entry?.status === 'draft'
            ? t('delete_warning_draft')
            : t('delete_warning_entry', { voucher: entry ? formatVoucher(entry) : '' })
        }
        confirmLabel={t('delete_confirm_label')}
      >
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
          <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium mb-1">{t('delete_dialog_heading')}</p>
            <p className="text-muted-foreground">
              {entry?.status === 'draft' ? t('delete_dialog_draft_body') : t('delete_dialog_entry_body')}
            </p>
          </div>
        </div>
      </ConfirmationDialog>

      {/* Reverse (storno) confirmation dialog */}
      <ConfirmationDialog
        open={showReverseConfirm}
        onOpenChange={setShowReverseConfirm}
        onConfirm={() => handleReverse()}
        isSubmitting={isReversing}
        title={t('reverse_confirm_title')}
        warningText={t('reverse_warning')}
        confirmLabel={t('reverse_confirm_label')}
      >
        <div className="flex items-start gap-3 rounded-lg border bg-muted/50 p-4">
          <RotateCcw className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium mb-1">{t('reverse_dialog_heading', { voucher: formatVoucher(entry) })}</p>
            <p className="text-muted-foreground">{t('reverse_dialog_body')}</p>
          </div>
        </div>
      </ConfirmationDialog>

      {/* Chain-depth guard confirm: the storno was refused because this entry
          already sits deep in a rättelse chain. Advisory, never a dead end. */}
      <ConfirmationDialog
        open={reverseDeepChainDepth != null}
        onOpenChange={(next) => { if (!next) setReverseDeepChainDepth(null) }}
        onConfirm={() => handleReverse(true)}
        isSubmitting={isReversing}
        title={t('deep_chain_title')}
        warningText={t('deep_chain_body', { depth: reverseDeepChainDepth ?? 3 })}
        confirmLabel={t('deep_chain_reverse_anyway')}
      >
        <div className="flex items-start gap-3 rounded-lg border bg-muted/50 p-4">
          <RotateCcw className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="font-medium mb-1">{t('deep_chain_reverse_heading', { voucher: formatVoucher(entry) })}</p>
            <p className="text-muted-foreground">{t('deep_chain_reverse_body')}</p>
          </div>
        </div>
      </ConfirmationDialog>
    </div>
  )
}
