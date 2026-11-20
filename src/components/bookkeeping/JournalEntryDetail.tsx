'use client'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'

import { useState, useCallback } from 'react'
import useSWR from 'swr'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { RecordHeader } from '@/components/ui/record-header'
import { PageHeaderOverflowItems } from '@/components/ui/page-header-actions'
import { useCommitDraft } from '@/components/bookkeeping/use-commit-draft'
import { AccountNumber } from '@/components/ui/account-number'
import { VoucherLinesTable, type VoucherTableLine } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineView } from '@/lib/bookkeeping/voucher-line-view'
import { Textarea } from '@/components/ui/textarea'
import {
  ArrowLeftIcon,
  ArrowUturnLeftIcon,
  CalendarDaysIcon,
  ChatBubbleLeftIcon,
  CpuChipIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  LockClosedIcon,
  PencilIcon,
  PencilSquareIcon,
  ScissorsIcon,
  Square2StackIcon,
  TrashIcon,
  UsersIcon,
} from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { AttnLine } from '@/components/ui/attn-line'
import { EmptyState, LoadError, NotFoundState } from '@/components/ui/empty-state'
import { HelpPopover } from '@/components/ui/help-popover'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import JournalEntryTransactionLinks from '@/components/bookkeeping/JournalEntryTransactionLinks'
import BookingWhy from '@/components/bookkeeping/BookingWhy'
import JournalEntryStatusBadge, { useSourceTypeLabels } from '@/components/bookkeeping/JournalEntryStatusBadge'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import CorrectOpeningBalanceDialog from '@/components/bookkeeping/CorrectOpeningBalanceDialog'
import SplitOpeningBalanceDialog from '@/components/bookkeeping/SplitOpeningBalanceDialog'
import StrikeLinesDialog from '@/components/bookkeeping/StrikeLinesDialog'
import CorrectMetadataDialog from '@/components/bookkeeping/CorrectMetadataDialog'
import EditDraftEntryDialog from '@/components/bookkeeping/EditDraftEntryDialog'
import RecordateEntryDialog from '@/components/bookkeeping/RecordateEntryDialog'
import CorrectionChain from '@/components/bookkeeping/CorrectionChain'
import RetagLineDialog, { type RetagLine } from '@/components/dimensions/RetagLineDialog'
import { ManualAccrualDialog, type ManualAccrualPrefill } from '@/components/bookkeeping/ManualAccrualDialog'
import { dimensionDisplayName } from '@/components/dimensions/dimension-label'
import { basDeferralDirection } from '@/lib/bookkeeping/result-account-ranges'
import { useCompanySettings } from '@/components/settings/useSettings'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useDimensions } from '@/lib/reference-data/hooks'
import { DetailPager } from '@/components/common/DetailPager'
import { listContextKey } from '@/lib/navigation/list-context'
import { useListReturnHref } from '@/lib/hooks/use-detail-pager'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { useAttribution } from '@/lib/attribution/use-attribution'
import type { JournalEntryLine } from '@/types'
import type { UnderlagReference } from '@/lib/core/bookkeeping/journal-entry-references'
import { OwnedVoucherActionDialog } from '@/components/bookkeeping/OwnedVoucherActionDialog'
import { useReverseJournalEntry } from '@/components/bookkeeping/use-reverse-journal-entry'
import { DetailPageSkeleton } from '@/components/common/DetailPageSkeleton'

import type { StruckLineSnapshot, JournalEntryDetailRead } from '@/lib/bookkeeping/journal-entry-detail-types'

// Ledger amounts render as plain sv-SE numbers with two decimals (no currency
// suffix), the same way the verifikat list's line tables do.
const fmtAmount = (value: number | string): string =>
  Number(value).toLocaleString('sv-SE', { minimumFractionDigits: 2 })

const NO_REFERENCES: UnderlagReference[] = []

/** Render the server read immediately and share subsequent reads within the active company. */
export default function JournalEntryDetail({ id, initialCompanyId, initialData }: {
  id: string
  initialCompanyId?: string
  initialData?: JournalEntryDetailRead
}) {
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const company = useCompanyOptional()?.company ?? null
  // Back to the verifikat list as it was when this verifikat was opened from
  // it: its filters, search and page (crm#1998).
  const listHref = useListReturnHref(listContextKey('bookkeeping', company?.id), '/bookkeeping', id)
  const { toast } = useToast()
  const t = useTranslations('journal_detail')
  const tCommon = useTranslations('common')
  const tNav = useTranslations('nav')
  const tCorrection = useTranslations('journal_correction')
  const tAccruals = useTranslations('accruals')
  const { format: attribute } = useAttribution()
  const sourceTypeLabels = useSourceTypeLabels()
  const seed = company?.id === initialCompanyId ? initialData : undefined
  const { data: detail, error: detailError, isLoading, mutate: mutateDetail } = useSWR<JournalEntryDetailRead>(
    company?.id ? ['journal-entry-detail', company.id, id] : null,
    async () => {
      const response = await fetch(`/api/bookkeeping/journal-entries/${id}/detail`)
      if (!response.ok) throw Object.assign(new Error(t('error_load_failed')), { status: response.status })
      return (await response.json()).data
    },
    { fallbackData: seed, revalidateOnFocus: false, shouldRetryOnError: false },
  )
  // A failed optional read is distinct from a successful empty list. Share
  // recovered references between voucher links and attachment discovery.
  const { data: retriedReferences } = useSWR<UnderlagReference[]>(
    company?.id && detail?.references === null ? ['journal-entry-references', company.id, id] : null,
    async () => {
      const response = await fetch(`/api/bookkeeping/journal-entries/${id}/references`)
      if (!response.ok) throw new Error(t('error_load_failed'))
      return (await response.json()).data.references
    },
    { revalidateOnFocus: false, errorRetryCount: 2 },
  )
  const notFound = detailError?.status === 404
  const entry = notFound ? null : detail?.entry ?? null
  const chain = detail?.chain ?? []
  const error = detailError && !notFound ? t('error_load_failed') : null
  const [showCorrection, setShowCorrection] = useState(false)
  const [showCorrectIB, setShowCorrectIB] = useState(false)
  const [showSplitIB, setShowSplitIB] = useState(false)
  const [showStrikeLines, setShowStrikeLines] = useState(false)
  const [showCorrectMetadata, setShowCorrectMetadata] = useState(false)
  const rattelseLog = detail?.rattelse_log ?? []
  const periodStatus = detail?.period_status ?? null
  const period = detail?.period
  const noteLock = period?.status === 'closed' ? 'closed'
    : period?.status === 'locked' && period.period_id && !period.lock_date ? 'locked' : null
  const filedVat = period?.filed_vat ?? null
  const [showEdit, setShowEdit] = useState(false)
  const [showRecordate, setShowRecordate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showReverseConfirm, setShowReverseConfirm] = useState(false)
  // Non-null when the server refused the storno with CORRECTION_CHAIN_TOO_DEEP:
  // holds the reported chain depth and opens the bypass confirm ("Återför ändå").
  const [reverseDeepChainDepth, setReverseDeepChainDepth] = useState<number | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  // Confirm-before-posting (convention 10). The list already gates this exact
  // action; the detail page used to fire the commit straight from the button.
  const [showCommitConfirm, setShowCommitConfirm] = useState(false)
  const [commitVoucherPreview, setCommitVoucherPreview] = useState<string | null>(null)
  const isLastInSeries = detail?.is_last_in_series ?? false
  // Set when the database refuses deleting this verifikat whatever the user
  // does (an SIE-imported verifikat, or the storno of an undone SIE import):
  // no "Radera verifikat" then, only where to go instead (PH 212).
  const deleteBlock = detail?.delete_block ?? null
  const [attachmentCount, setAttachmentCount] = useState(0)
  const references = detail?.references ?? retriedReferences ?? NO_REFERENCES
  // The object the verifikat books (an invoice, a periodisering, ...), from
  // the references GET: Vänd and Rätta lead with its own action first.
  const owner = detail?.owned_by ?? null
  const [ownedIntent, setOwnedIntent] = useState<'reverse' | 'correct_lines' | 'correct_date' | null>(null)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  // Dimension registry, fetched once when any line carries a dimensions map:
  // used to resolve display names for the per-line dimension text
  // ('Kostnadsställe: Butik') and the retag history; it falls back to raw
  // codes when the fetch fails or a code is unregistered.
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
  const [accrualPrefill, setAccrualPrefill] = useState<ManualAccrualPrefill | null>(null)
  const retagLog = detail?.retag_log ?? []
  const fetchData = useCallback(async () => {
    try {
      await mutateDetail()
    } catch { /* SWR exposes failed refreshes through detailError. */ }
  }, [mutateDetail])

  const saveNotes = useCallback(async (value: string) => {
    setSavingNotes(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: value || null }),
      })
      if (res.ok) {
        await mutateDetail(current => current ? { ...current, entry: { ...current.entry, notes: value || null } } : current, { revalidate: false })
        setEditingNotes(false)
      } else {
        // The refusal says why (a closed or locked period), not just that it failed.
        const result = await res.json().catch(() => null)
        toast({
          title: t('toast_save_note_failed'),
          ...(result ? { description: getErrorMessage(result, { context: 'journal_entry' }) } : {}),
          variant: 'destructive',
        })
      }
    } catch {
      toast({ title: t('toast_save_note_failed'), variant: 'destructive' })
    } finally {
      setSavingNotes(false)
    }
  }, [id, toast, t, mutateDetail])

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
      .catch(() => { /* The voucher preview is advisory; the commit endpoint assigns and validates the actual number. */ })
  }, [])

  // The commit meets the booking-time voucher warnings (useCommitDraft).
  const onDraftPosted = useCallback(
    async (posted: { voucher_series?: string | null; voucher_number?: number | null } | null) => {
      toast({
        title: t('toast_posted_title'),
        description: t('toast_posted_description', { voucher: formatVoucher(posted ?? {}) }),
      })
      await fetchData()
    },
    [toast, t, fetchData],
  )
  const onDraftCommitFailed = useCallback(
    (result: unknown) => {
      toast({ title: t('toast_post_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
    },
    [toast, t],
  )
  const { commit: commitDraft, dialog: commitWarningsDialog } = useCommitDraft({ onPosted: onDraftPosted, onFailed: onDraftCommitFailed })

  const handleCommit = useCallback(async () => {
    setIsCommitting(true)
    try {
      await commitDraft(id)
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setIsCommitting(false)
    }
  }, [id, toast, t, commitDraft])

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
        router.push(listHref)
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
  }, [id, router, toast, t, listHref])

  // Pure reversal (storno), shared with the journal list (useReverseJournalEntry).
  const { reverse, isReversing } = useReverseJournalEntry({
    onReversed: async () => {
      setShowReverseConfirm(false)
      setReverseDeepChainDepth(null)
      await fetchData()
    },
    onDeepChain: (depth) => {
      setShowReverseConfirm(false)
      setReverseDeepChainDepth(depth)
    },
  })
  const handleReverse = useCallback(
    (allowDeepChain = false) => reverse(id, allowDeepChain),
    [reverse, id],
  )


  if (isLoading) {
    return <DetailPageSkeleton />
  }

  if (error || !entry) {
    return (
      <div className="space-y-8">
        {!notFound && (
          <Link
            href={listHref}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {t('back')}
          </Link>
        )}
        {error ? (
          <LoadError title={error} onRetry={() => void fetchData()} />
        ) : notFound ? (
          <NotFoundState
            title={t('error_not_found')}
            description={t('not_found_hint')}
            backHref={listHref}
            backLabel={t('back')}
          />
        ) : (
          <EmptyState title={t('error_not_found')} />
        )}
      </div>
    )
  }

  const lines = ((entry.lines || []) as JournalEntryLine[])
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)

  const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)

  const foreignLines = lines.filter(l => l.currency && !isLedgerCurrency(l.currency) && l.amount_in_currency != null)
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
      (r.struck_lines ?? []).map((s) => ({
        ...s,
        struck_at: r.created_at,
        struck_by: r.source === 'sie_import' ? (r.external_signature ?? null) : r.actor_label,
        imported: r.source === 'sie_import',
      }))
    )

  // The struck marker beside a struck row: who and when at a glance, the
  // date alone when the actor could not be resolved. Imported history has no
  // "when" (SIE carries only the signature), so it says where instead.
  const struckMarker = (s: { struck_at: string; struck_by: string | null; imported?: boolean }) => {
    if (s.imported) {
      return s.struck_by
        ? t('struck_marker_imported_by', { actor: s.struck_by })
        : t('struck_marker_imported')
    }
    return s.struck_by
      ? t('struck_marker_by', { date: formatDate(s.struck_at), actor: s.struck_by })
      : t('struck_marker', { date: formatDate(s.struck_at) })
  }

  // Live and struck lines interleaved by original position.
  const displayRows: Array<
    | { kind: 'live'; line: JournalEntryLine }
    | { kind: 'struck'; line: StruckLineSnapshot & { struck_at: string; struck_by: string | null; imported?: boolean } }
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

  // Display-only dimension text for a line (e.g. 'Kostnadsställe: Butik ·
  // Projekt: P001'). Every dimension is prefixed by its registry name
  // (dimensionDisplayName), the system pair included, so a custom dimension
  // reads like the built-in ones. Value names resolve through the registry
  // when loaded; raw codes otherwise. Muted text, not chips: dimensions are
  // normal data on a line, and chips mark exceptions only. Stays Swedish
  // (verifikat surface).
  const renderDimensions = (line: JournalEntryLine) => {
    const entries = Object.entries(line.dimensions ?? {})
      .filter(([, code]) => code)
      .sort(([a], [b]) => Number(a) - Number(b))
    if (entries.length === 0) return null
    const text = entries
      .map(([dimNo, code]) => {
        const dim = registryDims?.find((d) => String(d.sie_dim_no) === dimNo)
        const value = dim?.values.find((v) => v.code === code)
        const hasName = !!value && value.name !== '' && value.name !== value.code
        return `${dimensionDisplayName(registryDims, dimNo)}: ${hasName ? value.name : code}`
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
        className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        aria-label={t('dimension_edit')}
        title={t('dimension_edit_hint')}
      >
        <PencilIcon className="h-3 w-3" />
      </button>
    ) : null

  // "Periodisera" only on a line that put an amount on a förutbetald account
  // (a debit on 1710-1740/1790, a credit on 2970-2979): the dialog prefills
  // what remains on the account, read from the ledger.
  const accrualButton = (line: JournalEntryLine) => {
    const direction = basDeferralDirection(line.account_number)
    if (!canWrite || entry.status !== 'posted' || !direction) return null
    const net = Number(line.debit_amount ?? 0) - Number(line.credit_amount ?? 0)
    if (direction === 'expense' ? net <= 0 : net >= 0) return null
    return (
      <button
        type="button"
        className="rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        onClick={() => setAccrualPrefill({
          direction,
          balance_account: line.account_number,
          description: entry.description ?? '',
          origin_journal_entry_id: entry.id,
          origin_label: formatVoucher(entry),
        })}
      >
        {tAccruals('line_action')}
      </button>
    )
  }

  // Title in the serif: the voucher label for posted entries, a plain
  // "Utkast till verifikat" while the number is still unassigned.
  const title = entry.status === 'draft' ? t('title_draft') : t('title', { label: formatVoucher(entry) })

  // The posting date lives once, in Detaljer ("Bokförd"), not also here.
  const metaParts = [formatDate(entry.entry_date), entry.description].filter(Boolean)

  // Header actions (convention 9): the one next step as a filled button, at
  // most a couple of quiet secondaries, everything else in the ⋯ menu. The
  // old surface offered no actions at all on reversed/cancelled entries; keep
  // that gate.
  const showActions = entry.status === 'posted' || entry.status === 'draft'
  const deleteOffered = entry.status === 'draft' || isLastInSeries
  const showDelete = deleteOffered && !deleteBlock
  const showRattelseGroup = canCorrect && !isOpeningBalance
  // Inline rättelse is the normal correction path while the period is open,
  // so "Stryk rader" is promoted to a visible secondary button there (#1554:
  // a user who never opens the ⋯ menu concluded the feature did not exist).
  // The ⋯ item stays, so the menu remains the complete action list.
  const showStrikeButton = showRattelseGroup && canInlineRattelse && periodStatus === 'open'
  // A year closed with a year-end closing takes no storno and no rättelse:
  // every action in the Rätta group would be refused (crm#1290). They stay
  // listed but disabled, with the way on in their place: a new verifikat in
  // the open year, or support reopening a year whose årsredovisning is
  // unsigned. Unknown status keeps them enabled; the server still decides.
  const yearClosed = periodStatus === 'closed'

  const underlagAside = (() => {
    if (attachmentCount === 0 && references.length === 0) {
      return <AttnLine>{t('no_attachments')}</AttnLine>
    }
    const parts = [
      attachmentCount > 0 ? t('attachments_count', { count: attachmentCount }) : null,
      references.length > 0 ? t('references_count', { count: references.length }) : null,
    ].filter(Boolean)
    return <span className="text-xs tabular-nums text-muted-foreground">{parts.join(' · ')}</span>
  })()

  const statusChips = (
    <>
      <JournalEntryStatusBadge entry={entry} showStatus={entry.status !== 'posted'} />
      {rattelseLog.length > 0 && (
        <Badge variant="outline" title={t('rattelse_history_title')}>
          {t('corrected_label')}
        </Badge>
      )}
    </>
  )

  return (
    <div className="space-y-8 stagger-enter">
      {/* Header: title, status chips only for deviations (a plain posted
          verifikat carries none), a quiet meta line, the next step right.
          The page-header hooks turn it into the top bar, like the invoice
          detail page: the sidebar says where we are, so there is no back
          link, and the prev/next pager sits in the bar. */}
      <RecordHeader
        parent={{ label: tNav('v3_vouchers'), href: listHref }}
        title={title}
        // The title carries the voucher number, the facts the entry description.
        mask
        help={
          // Convention 7: which correction track applies when, behind the "?"
          <HelpPopover>
            <p>{t('help_rattelse_tracks_open')}</p>
            <p className="mt-2">{t('help_rattelse_tracks_locked')}</p>
          </HelpPopover>
        }
        status={statusChips}
        facts={metaParts.join(' · ')}
        actions={<>
          <DetailPager
            contextKey={listContextKey('bookkeeping', company?.id)}
            basePath="/bookkeeping"
            currentId={id}
            className="shrink-0"
            // Arrow paging unmounts the page and would destroy an unsaved notes
            // draft; the textarea only guards arrows while it has focus, so gate
            // the keyboard bindings on the editing state itself.
            keyboard={!editingNotes}
          />
          {showActions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {entry.status === 'draft' && (
                <Button size="toolbar"
                  variant="outline"
                  onClick={() => setShowEdit(true)}
                  disabled={!canWrite}
                  title={!canWrite ? t('read_only_tooltip') : undefined}
                >
                  {!canWrite ? <LockClosedIcon className="h-4 w-4" /> : <PencilIcon className="h-4 w-4" />}
                  {t('edit_draft')}
                </Button>
              )}
              {entry.status === 'draft' && (
                <Button size="toolbar"
                  onClick={openCommitConfirm}
                  disabled={!canWrite}
                  loading={isCommitting}
                  title={!canWrite ? t('read_only_tooltip') : undefined}
                >
                  {!canWrite && !isCommitting && <LockClosedIcon className="h-4 w-4" />}
                  {t('post')}
                </Button>
              )}
              {canCorrect && isOpeningBalance && (
                <Button size="toolbar"
                  variant="outline"
                  onClick={() => setShowCorrectIB(true)}
                  disabled={!canWrite}
                  title={!canWrite ? t('read_only_tooltip') : undefined}
                >
                  {!canWrite ? <LockClosedIcon className="h-4 w-4" /> : <PencilIcon className="h-4 w-4" />}
                  {t('correct_opening_balances')}
                </Button>
              )}
              {showStrikeButton && (
                <Button size="toolbar"
                  variant="outline"
                  onClick={() => setShowStrikeLines(true)}
                  disabled={!canWrite}
                  title={!canWrite ? t('read_only_tooltip') : undefined}
                >
                  {!canWrite ? <LockClosedIcon className="h-4 w-4" /> : <ScissorsIcon className="h-4 w-4" />}
                  {t('strike_lines')}
                </Button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-toolbar" aria-label={tCommon('more_options')} data-topbar-overflow-host="">
                    <EllipsisHorizontalIcon className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[240px]">
                  {/* On a phone the bar's other actions are listed here first. */}
                  <PageHeaderOverflowItems />
                  {/* Copy is not status-gated: it only prefills a fresh manual
                      draft (no voucher number, date or attachments carried over),
                      so it is offered on drafts too, matching the list surfaces. */}
                  <DropdownMenuItem asChild disabled={!canWrite}>
                    <Link href={`/bookkeeping?copy_from=${entry.id}`}>
                      <Square2StackIcon className="h-4 w-4" />
                      {t('copy_entry')}
                    </Link>
                  </DropdownMenuItem>
                  {/* "Dela upp IB per projekt" (#3313): the IB verifikat's
                      own inline rättelse; the dialog previews first and the
                      server refuses a year that does not allow it. */}
                  {canCorrect && isOpeningBalance && entry.fiscal_period_id && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => setShowSplitIB(true)} disabled={!canWrite}>
                        <ScissorsIcon className="h-4 w-4" />
                        {t('split_opening_balance_per_project')}
                      </DropdownMenuItem>
                    </>
                  )}
                  {showRattelseGroup && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuLabel>{t('correct_menu')}</DropdownMenuLabel>
                      {yearClosed && (
                        <p className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground">
                          {t('correct_menu_year_closed')}
                        </p>
                      )}
                      {filedVat && periodStatus === 'open' && (
                        <p className="max-w-64 px-2 pb-1.5 text-xs text-muted-foreground">
                          {t('correct_menu_period_filed', { period: filedVat.tax_period, date: formatDate(filedVat.filed_on) })}
                        </p>
                      )}
                      {canInlineRattelse && (
                        <DropdownMenuItem onSelect={() => setShowStrikeLines(true)} disabled={!canWrite || yearClosed}>
                          <ScissorsIcon className="h-4 w-4" />
                          {t('strike_lines')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => setShowCorrectMetadata(true)} disabled={!canWrite || yearClosed}>
                        <PencilSquareIcon className="h-4 w-4" />
                        {t('correct_metadata')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => (owner ? setOwnedIntent('correct_lines') : setShowCorrection(true))} disabled={!canWrite || yearClosed}>
                        <PencilIcon className="h-4 w-4" />
                        {t('correct_lines')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => (owner ? setOwnedIntent('correct_date') : setShowRecordate(true))} disabled={!canWrite || yearClosed}>
                        <CalendarDaysIcon className="h-4 w-4" />
                        {t('correct_date')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => (owner ? setOwnedIntent('reverse') : setShowReverseConfirm(true))} disabled={!canWrite || yearClosed}>
                        <ArrowUturnLeftIcon className="h-4 w-4" />
                        {t('reverse_action')}
                      </DropdownMenuItem>
                    </>
                  )}
                  {deleteOffered && deleteBlock && (
                    <>
                      <DropdownMenuSeparator />
                      <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                        {deleteBlock === 'sie_batch_entry'
                          ? t('delete_blocked_sie_batch')
                          : t('delete_blocked_sie_undo_storno')}
                      </p>
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
                        <TrashIcon className="h-4 w-4" />
                        {entry.status === 'draft' ? t('delete_draft') : t('delete_entry')}
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </>}
      />

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
          {/* The object the verifikat books, unless Underlag already links it. */}
          {owner && !references.some((ref) => ref.id === owner.owner_id) && (
            <DefRow label={t('owned_by_field')}>
              <Link href={owner.href} className="hover:underline">
                {`${t(`owner_name_${owner.kind}`)} ${owner.label ?? ''}`.trim()}
              </Link>
            </DefRow>
          )}
          {/* The bank / skattekonto händelse behind the entry, when there is
              one: followable in the other direction from "Visa verifikat". */}
          <JournalEntryTransactionLinks journalEntryId={entry.id} variant="detail" />
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
                {entry.committed_actor_type !== 'user' && <CpuChipIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                {/* Who relayed the commit (committed_actor_*; commit_method
                    records how), named with the person it acted for:
                    committed_by, or the entry's user before it was stamped. */}
                {attribute({
                  actorType: entry.committed_actor_type,
                  actorLabel: entry.committed_actor_label,
                  userId: entry.committed_by ?? entry.user_id,
                })}
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

        {/* Notes: internal metadata, not BFL verifikation content; editable
            while the entry's period is open (a closed or locked period is
            read-only, the note included). */}
        <DetailSection
          kicker={t('field_note')}
          aside={
            !editingNotes && canWrite && !noteLock && entry.notes ? (
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
                  onClick={() => setEditingNotes(false)}
                  disabled={savingNotes}
                >
                  {tCommon('cancel')}
                </Button>
                <Button
                  onClick={() => saveNotes(notesValue)}
                  loading={savingNotes}
                >
                  {tCommon('save')}
                </Button>
              </div>
            </div>
          ) : entry.notes ? (
            // break-words: a pasted link or reference has no break point and
            // ran past a phone's edge.
            <p className="py-2 text-sm whitespace-pre-wrap break-words">{entry.notes}</p>
          ) : canWrite && !noteLock ? (
            // An empty, editable note is an action, not a muted "Ingen
            // anteckning" next to a quiet Ändra (accounted#183).
            <div className="py-2">
              <Button variant="outline" onClick={() => { setNotesValue(''); setEditingNotes(true) }}>
                <ChatBubbleLeftIcon className="mr-2 h-4 w-4" />
                {t('add_note')}
              </Button>
            </div>
          ) : (
            <p className="py-2 text-sm text-muted-foreground">{t('no_note')}</p>
          )}
          {noteLock && !editingNotes && (
            <p className="text-xs text-muted-foreground">
              {t(noteLock === 'closed' ? 'note_period_closed' : 'note_period_locked')}
            </p>
          )}
        </DetailSection>
      </div>

      {/* Lines: the list-page table idiom straight on the panel. */}
      <DetailSection
        kicker={t('lines_title')}
        aside={
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('lines_count', { count: lines.length })}
          </span>
        }
      >
        <VoucherLinesTable
          swedish
          showTotals
          className="text-[13px]"
          lines={displayRows.map((row): VoucherTableLine => {
            if (row.kind === 'struck') {
              const s = row.line
              return {
                ...voucherLineView(s),
                key: `struck-${s.id}`,
                struck: true,
                extra: <span data-ph-mask="" className="text-xs">{struckMarker(s)}</span>,
              }
            }
            const line = row.line
            return {
              ...voucherLineView(line),
              extra: (
                <>
                  {accrualButton(line)}
                  {retagButton(line)}
                  {renderDimensions(line)}
                </>
              ),
            }
          })}
        />
      </DetailSection>

      {/* Underlag: linked invoices and lönekörningar as rows, then the
          document list. Each row is the followable half of a link the app
          already stores (BFL 5 kap 7 §, hänvisning till underlag). */}
      <DetailSection kicker={t('attachments_title')} aside={underlagAside}>
        {references.length > 0 && (
          <DefRow label={t('references_title')} className="items-baseline">
            <ul className="divide-y divide-border">
              {references.map((ref) => {
                const href =
                  ref.type === 'invoice'
                    ? `/invoices/${ref.id}`
                    : ref.type === 'supplier_invoice'
                      ? `/supplier-invoices/${ref.id}`
                      : `/salary/runs/${ref.id}`
                // A supplier invoice without the supplier's number (NULL)
                // reads as plain "Leverantörsfaktura" and still links to it.
                const number = ref.number ?? ''
                const label =
                  ref.type === 'invoice'
                    ? t('reference_invoice', { number })
                    : ref.type === 'supplier_invoice'
                      ? t('reference_supplier_invoice', { number })
                      : t('reference_salary_run', { number })
                const Icon = ref.type === 'salary_run' ? UsersIcon : DocumentTextIcon
                return (
                  <li key={`${ref.type}-${ref.id}`} className="py-1 first:pt-0 last:pb-0">
                    <Link href={href} className="inline-flex items-center gap-2 hover:underline">
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{label}</span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </DefRow>
        )}
        <JournalEntryAttachments
          journalEntryId={entry.id}
          references={references}
          onCountChange={setAttachmentCount}
          variant="section"
        />
      </DetailSection>

      {/* Därför bokades den så: who booked it, how and when, from the
          recorded decision receipts; the detail starts collapsed. Booked
          entries only: a draft has not been decided yet. */}
      {(entry.status === 'posted' || entry.status === 'reversed') && <BookingWhy journalEntryId={entry.id} />}

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
                  {/* data-ph-mask: the actor label is a person's e-mail or name */}
                  <span data-ph-mask="" className="text-muted-foreground">
                    <span className="tabular-nums">{formatDate(row.created_at)}</span>
                    {row.source === 'sie_import'
                      ? row.external_signature
                        ? ` · ${t('rattelse_imported_signature', { actor: row.external_signature })}`
                        : ''
                      : row.actor_label
                        ? ` · ${row.actor_label}`
                        : ''}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.source === 'sie_import'
                      ? t('rattelse_kind_imported')
                      : row.rattelse_type === 'metadata'
                        ? t('rattelse_kind_metadata')
                        : t('rattelse_kind_lines')}
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
                        <span className="line-through decoration-foreground/25">
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
          before/after trail. Stays Swedish (voucher detail surface). Each
          side shows the dimension's registry name and the code as logged:
          codes are what the trail recorded, names can change later. */}
      {dimensionsEnabled && retagLog.length > 0 && (
        <DetailSection kicker={t('dimension_history')}>
          <ul className="divide-y divide-border text-sm">
            {retagLog.map((row) => {
              const lineForRow = lines.find((l) => l.id === row.line_id)
              const fmt = (dims: Record<string, string>) => {
                const entries = Object.entries(dims ?? {}).sort(([a], [b]) => Number(a) - Number(b))
                return entries.length > 0
                  ? entries.map(([no, code]) => `${dimensionDisplayName(registryDims, no)}: ${code}`).join(', ')
                  : '-'
              }
              return (
                <li key={row.id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="tabular-nums text-muted-foreground">{formatDate(row.created_at)}</span>
                    {lineForRow && <AccountNumber number={lineForRow.account_number} />}
                  </div>
                  {/* data-ph-mask: dimension names and codes are user data */}
                  <p data-ph-mask="" className="tabular-nums">
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

      <ManualAccrualDialog
        open={accrualPrefill !== null}
        onOpenChange={(open) => { if (!open) setAccrualPrefill(null) }}
        prefill={accrualPrefill ?? undefined}
        onCreated={fetchData}
      />

      {/* Inline rättelse dialogs (strike lines / metadata) */}
      {showStrikeLines && entry && (
        <StrikeLinesDialog
          entry={entry}
          open={showStrikeLines}
          onOpenChange={setShowStrikeLines}
          filedVat={periodStatus === 'open' ? filedVat : null}
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
          filedVat={periodStatus === 'open' ? filedVat : null}
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

      {/* Split the IB per project: inline rättelse of the same verifikat */}
      {showSplitIB && entry?.fiscal_period_id && (
        <SplitOpeningBalanceDialog
          fiscalPeriodId={entry.fiscal_period_id}
          open={showSplitIB}
          onOpenChange={setShowSplitIB}
          onApplied={() => {
            setShowSplitIB(false)
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
        {/* Plain consequence text: the title names the action and the attn
            line carries the warning, so no second boxed banner. */}
        <p className="text-sm text-muted-foreground">
          {entry?.status === 'draft' ? t('delete_dialog_draft_body') : t('delete_dialog_entry_body')}
        </p>
      </ConfirmationDialog>

      {/* Vänd or Rätta on a verifikat an object owns: its own action first,
          the verifikat alone as the second way on. */}
      {owner && ownedIntent && (
        <OwnedVoucherActionDialog
          owner={owner}
          intent={ownedIntent === 'reverse' ? 'reverse' : 'correct'}
          open
          onOpenChange={(next) => {
            if (!next) setOwnedIntent(null)
          }}
          onProceed={() => {
            if (ownedIntent === 'reverse') setShowReverseConfirm(true)
            else if (ownedIntent === 'correct_lines') setShowCorrection(true)
            else setShowRecordate(true)
          }}
        />
      )}

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
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t('reverse_dialog_heading', { voucher: formatVoucher(entry) })}</p>
          <p className="text-muted-foreground">{t('reverse_dialog_body')}</p>
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
        <div className="space-y-1 text-sm">
          <p className="font-medium">{t('deep_chain_reverse_heading', { voucher: formatVoucher(entry) })}</p>
          <p className="text-muted-foreground">{t('deep_chain_reverse_body')}</p>
        </div>
      </ConfirmationDialog>

      {/* Booking-time voucher warnings on the draft's commit */}
      {commitWarningsDialog}
    </div>
  )
}
