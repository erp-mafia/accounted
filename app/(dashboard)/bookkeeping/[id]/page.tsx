'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AccountNumber } from '@/components/ui/account-number'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, ArrowLeft, Paperclip, AlertTriangle, Lock, MessageSquare, Pencil, Check, X, Copy, ChevronDown, CalendarClock, FileText, Link2, RotateCcw } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import JournalEntryStatusBadge, { useSourceTypeLabels } from '@/components/bookkeeping/JournalEntryStatusBadge'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import CorrectOpeningBalanceDialog from '@/components/bookkeeping/CorrectOpeningBalanceDialog'
import EditDraftEntryDialog from '@/components/bookkeeping/EditDraftEntryDialog'
import RecordateEntryDialog from '@/components/bookkeeping/RecordateEntryDialog'
import AgentSparkleButton from '@/components/agent/AgentSparkleButton'
import CorrectionChain from '@/components/bookkeeping/CorrectionChain'
import RetagLineDialog, { type RetagLine } from '@/components/dimensions/RetagLineDialog'
import { useCompanySettings } from '@/components/settings/useSettings'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { fetchDimensions, type DimensionDto } from '@/components/dimensions/types'
import type { JournalEntry, JournalEntryLine } from '@/types'
import type { UnderlagReference } from '@/lib/core/bookkeeping/journal-entry-references'

export default function JournalEntryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const t = useTranslations('journal_detail')
  const sourceTypeLabels = useSourceTypeLabels()
  const [entry, setEntry] = useState<JournalEntry | null>(null)
  const [chain, setChain] = useState<JournalEntry[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showCorrection, setShowCorrection] = useState(false)
  const [showCorrectIB, setShowCorrectIB] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showRecordate, setShowRecordate] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showReverseConfirm, setShowReverseConfirm] = useState(false)
  const [isReversing, setIsReversing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isLastInSeries, setIsLastInSeries] = useState(false)
  const [attachmentCount, setAttachmentCount] = useState(0)
  const [references, setReferences] = useState<UnderlagReference[]>([])
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  // Dimension registry, fetched once when any line carries a dimensions map:
  // used to resolve display names for the line badges ('KS: Butik'); badges
  // fall back to raw codes when the fetch fails or a code is unregistered.
  const [registryDims, setRegistryDims] = useState<DimensionDto[] | null>(null)
  // Tier-2 retro-tagging (dimensions plan PR6): pencil on posted lines opens
  // the audited retag dialog; the log renders as a history disclosure below.
  // Both render only when dimensions are enabled for the company.
  const { settings } = useCompanySettings()
  const dimensionsEnabled = settings?.dimensions_enabled === true
  const [retagLine, setRetagLine] = useState<RetagLine | null>(null)
  const [retagLog, setRetagLog] = useState<
    { id: string; line_id: string; old_dimensions: Record<string, string>; new_dimensions: Record<string, string>; reason: string; created_at: string }[]
  >([])

  useEffect(() => {
    if (registryDims !== null) return
    const entryLines = (entry?.lines || []) as JournalEntryLine[]
    if (!entryLines.some((l) => l.dimensions && Object.keys(l.dimensions).length > 0)) return
    let cancelled = false
    fetchDimensions()
      .then((dims) => {
        if (!cancelled) setRegistryDims(dims)
      })
      .catch(() => {/* display-only, raw codes are fine */})
    return () => {
      cancelled = true
    }
  }, [entry, registryDims])

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const [chainRes, refsRes, retagRes] = await Promise.all([
        fetch(`/api/bookkeeping/journal-entries/${id}/chain`),
        fetch(`/api/bookkeeping/journal-entries/${id}/references`),
        fetch(`/api/bookkeeping/journal-entries/${id}/retag-log`),
      ])
      if (retagRes.ok) {
        const retagPayload = await retagRes.json()
        setRetagLog(Array.isArray(retagPayload.data) ? retagPayload.data : [])
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
  const handleReverse = useCallback(async () => {
    setIsReversing(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/reverse`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const storno = result.data
        toast({
          title: t('toast_reverse_done_title'),
          description: t('toast_reverse_done_description', { voucher: formatVoucher(storno ?? {}) }),
        })
        setShowReverseConfirm(false)
        await fetchData()
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
      <div className="space-y-4">
        <Link
          href="/bookkeeping"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Link>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{error || t('error_not_found')}</p>
          </CardContent>
        </Card>
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

  // An opening-balance verifikat must be corrected through the IB-aware flow
  // (storno + rebook + relink the period's opening_balance_entry_id), never the
  // generic "Rätta rader": that books a `correction` entry but leaves the
  // period pointing at the stornoed IB, so the Balansrapport "Ingående balans"
  // column goes stale. Only surface it on the *active* IB (posted; stornoed
  // predecessors are `reversed`, so exactly one posted IB exists per period).
  const isOpeningBalance = entry.source_type === 'opening_balance' && entry.status === 'posted'

  // Include current entry in the chain for the visualization
  const fullChain = [entry, ...chain]

  // SIE dimension badge prefixes. 'KS' is the market-standard abbreviation
  // for kostnadsställe; projekt has no standard abbreviation (Fortnox/Visma
  // show the dimension name, and 'PR' collides with prisnivå in some BAS
  // setups, flagged in the #859 compliance review), so dim 6 falls through
  // to the registry name below. Stays Swedish per .claude/rules/i18n.md.
  const DIM_BADGE_PREFIX: Record<string, string> = { '1': 'KS' }

  // Display-only dimension badges for a line (e.g. 'KS: Butik', 'PR: P001').
  // Names resolve through the registry when loaded; raw codes otherwise.
  const renderDimensionBadges = (line: JournalEntryLine) => {
    const entries = Object.entries(line.dimensions ?? {})
      .filter(([, code]) => code)
      .sort(([a], [b]) => Number(a) - Number(b))
    if (entries.length === 0) return null
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {entries.map(([dimNo, code]) => {
          const dim = registryDims?.find((d) => String(d.sie_dim_no) === dimNo)
          const value = dim?.values.find((v) => v.code === code)
          const prefix = DIM_BADGE_PREFIX[dimNo] ?? dim?.name ?? `Dim ${dimNo}`
          const hasName = !!value && value.name !== '' && value.name !== value.code
          return (
            <Badge
              key={dimNo}
              variant="outline"
              className="font-mono text-[11px] font-normal"
              title={`${dim?.name ?? prefix} ${code}${hasName ? `: ${value.name}` : ''}`}
            >
              {prefix}: {hasName ? value.name : code}
            </Badge>
          )
        })}
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Back link */}
      <Link
        href="/bookkeeping"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('back')}
      </Link>

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-display text-2xl md:text-3xl tracking-tight font-mono">
              {formatVoucher(entry)}
            </h1>
            <JournalEntryStatusBadge entry={entry} />
          </div>
          <p className="text-muted-foreground">{entry.description}</p>
        </div>

        {(entry.status === 'posted' || entry.status === 'draft') && (
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            {entry.status === 'draft' && (
              <AgentSparkleButton
                intentId="verifikation.draft"
                intentArgs={{ journal_entry_id: id }}
                contextRef={`verifikation:${id}`}
                className="w-full sm:w-auto"
              />
            )}
            {entry.status === 'draft' && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
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
                size="sm"
                className="w-full sm:w-auto"
                onClick={handleCommit}
                disabled={!canWrite || isCommitting}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : isCommitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('post')}
              </Button>
            )}
            {(entry.status === 'draft' || isLastInSeries) && (
              <Button
                variant="destructive"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={!canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                {entry.status === 'draft' ? t('delete_draft') : t('delete_entry')}
              </Button>
            )}
            {canCorrect && !isOpeningBalance && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={!canWrite}
                    title={!canWrite ? t('read_only_tooltip') : undefined}
                  >
                    {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : <Pencil className="mr-2 h-4 w-4" />}
                    {t('correct_menu')}
                    <ChevronDown className="ml-2 h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setShowCorrection(true)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t('correct_lines')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowRecordate(true)}>
                    <CalendarClock className="mr-2 h-4 w-4" />
                    {t('correct_date')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setShowReverseConfirm(true)}>
                    <RotateCcw className="mr-2 h-4 w-4" />
                    {t('reverse_action')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {canCorrect && isOpeningBalance && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowCorrectIB(true)}
                disabled={!canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : <Pencil className="mr-2 h-4 w-4" />}
                {t('correct_opening_balances')}
              </Button>
            )}
            {entry.status === 'posted' && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => router.push(`/bookkeeping?copy_from=${entry.id}`)}
                disabled={!canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {t('copy_entry')}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Info cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('details_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('field_date')}</span>
              <span>{formatDate(entry.entry_date)}</span>
            </div>
            {entry.committed_at && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('field_posted_at')}</span>
                <span>{formatDate(entry.committed_at)}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('field_type')}</span>
              <span>{sourceTypeLabels[entry.source_type] || entry.source_type}</span>
            </div>
            {entry.source_voucher_series && entry.source_voucher_number != null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('field_source_voucher')}</span>
                <span className="font-mono tabular-nums">
                  {formatVoucher({ voucher_series: entry.source_voucher_series, voucher_number: entry.source_voucher_number })}
                </span>
              </div>
            )}
            {/* Notes: always editable (internal metadata, not BFL verifikation content) */}
            <div className="border-t pt-2 mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-muted-foreground flex items-center gap-1">
                  <MessageSquare className="h-3.5 w-3.5" />
                  {t('field_note')}
                </span>
                {!editingNotes && canWrite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { setNotesValue(entry.notes || ''); setEditingNotes(true) }}
                    aria-label={t('edit_note_aria')}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
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
                  <div className="flex gap-1 justify-end">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => setEditingNotes(false)}
                      disabled={savingNotes}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => saveNotes(notesValue)}
                      disabled={savingNotes}
                    >
                      {savingNotes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">
                  {entry.notes || t('no_note')}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('summary_title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('summary_debit')}</span>
              <span className="tabular-nums font-medium">
                {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('summary_credit')}</span>
              <span className="tabular-nums font-medium">
                {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t('summary_lines')}</span>
              <span>{lines.length}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('attachments_title')}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {attachmentCount === 0 && references.length === 0 ? (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-foreground" />
                <span className="text-muted-foreground">{t('no_attachments')}</span>
              </div>
            ) : (
              <div className="space-y-1">
                {attachmentCount > 0 && (
                  <div className="flex items-center gap-2">
                    <Paperclip className="h-4 w-4 text-muted-foreground" />
                    <span>{t('attachments_count', { count: attachmentCount })}</span>
                  </div>
                )}
                {references.length > 0 && (
                  <div className="flex items-center gap-2">
                    <Link2 className="h-4 w-4 text-muted-foreground" />
                    <span>{t('references_count', { count: references.length })}</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Foreign-currency conversion audit chip */}
      {hasForeignCurrency && foreignCurrency && (
        <Card>
          <CardContent className="p-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
              {t('currency_title')}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
              <div className="flex justify-between sm:block">
                <span className="text-muted-foreground">{t('currency_rate')}</span>
                <span className="tabular-nums sm:block">
                  {foreignExchangeRate
                    ? `1 ${foreignCurrency} = ${foreignExchangeRate.toLocaleString('sv-SE', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} SEK`
                    : '-'}
                </span>
              </div>
              <div className="flex justify-between sm:block">
                <span className="text-muted-foreground">{t('currency_original_amount')}</span>
                <span className="tabular-nums sm:block">
                  {foreignTotal.toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {foreignCurrency}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lines table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t('lines_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Desktop table */}
          <div className="hidden sm:block">
            <table className="w-full text-sm">
              <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-2 w-48">{t('col_account')}</th>
                  <th className="py-2">{t('col_description')}</th>
                  <th className="py-2 w-28 text-right">{t('col_debit')}</th>
                  <th className="py-2 w-28 text-right">{t('col_credit')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => {
                  const hasForeignCurrency = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
                  return (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-2"><AccountNumber number={line.account_number} showName /></td>
                      <td className="py-2 text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          {line.line_description || ''}
                          {dimensionsEnabled && canWrite && entry.status === 'posted' && (
                            <button
                              type="button"
                              onClick={() => setRetagLine(line as unknown as RetagLine)}
                              className="p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary/60 transition-colors"
                              aria-label="Ändra dimensioner"
                              title="Ändra dimensioner (påverkar endast internredovisningen)"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </span>
                        {renderDimensionBadges(line)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {Number(line.debit_amount) > 0 && (
                          <>
                            {Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                            {hasForeignCurrency && Number(line.debit_amount) > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {Number(line.credit_amount) > 0 && (
                          <>
                            {Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                            {hasForeignCurrency && Number(line.credit_amount) > 0 && (
                              <span className="block text-xs text-muted-foreground">
                                {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
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
                <tr className="font-semibold">
                  <td colSpan={2} className="py-2">{t('sum')}</td>
                  <td className="py-2 text-right tabular-nums">
                    {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="sm:hidden space-y-2">
            {lines.map((line) => {
              const hasForeignCurrency = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
              return (
                <div key={line.id} className="flex items-center justify-between py-2 border-b last:border-0 gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm flex items-center gap-1">
                      <AccountNumber number={line.account_number} showName />
                      {dimensionsEnabled && canWrite && entry.status === 'posted' && (
                        <button
                          type="button"
                          onClick={() => setRetagLine(line as unknown as RetagLine)}
                          className="p-1 rounded text-muted-foreground/50 hover:text-foreground transition-colors"
                          aria-label="Ändra dimensioner"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {line.line_description && (
                      <p className="text-xs text-muted-foreground truncate">{line.line_description}</p>
                    )}
                    {renderDimensionBadges(line)}
                  </div>
                  <div className="text-right shrink-0 text-sm tabular-nums">
                    {Number(line.debit_amount) > 0 && (
                      <p>
                        {Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} D
                        {hasForeignCurrency && (
                          <span className="block text-xs text-muted-foreground">
                            {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                          </span>
                        )}
                      </p>
                    )}
                    {Number(line.credit_amount) > 0 && (
                      <p>
                        {Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} K
                        {hasForeignCurrency && (
                          <span className="block text-xs text-muted-foreground">
                            {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                </div>
              )
            })}
            <div className="flex justify-between font-semibold text-sm pt-1">
              <span>{t('sum')}</span>
              <div className="flex gap-3 tabular-nums">
                <span>D: {totalDebit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
                <span>K: {totalCredit.toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Attachments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t('attachments_title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {references.length > 0 && (
            <div className="mb-4 space-y-2">
              <div>
                <h4 className="text-sm font-medium">{t('references_title')}</h4>
                <p className="text-xs text-muted-foreground">{t('references_subtitle')}</p>
              </div>
              <ul className="space-y-1">
                {references.map((ref) => (
                  <li key={`${ref.type}-${ref.id}`}>
                    <Link
                      href={ref.type === 'invoice' ? `/invoices/${ref.id}` : `/supplier-invoices/${ref.id}`}
                      className="flex items-center gap-2 text-sm py-1.5 px-2 rounded bg-muted/50 hover:bg-secondary/60 transition-colors"
                    >
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {ref.type === 'invoice'
                          ? t('reference_invoice', { number: ref.number })
                          : t('reference_supplier_invoice', { number: ref.number })}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <JournalEntryAttachments
            journalEntryId={entry.id}
            onCountChange={setAttachmentCount}
          />
        </CardContent>
      </Card>

      {/* Correction chain */}
      {chain.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">{t('history_title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <CorrectionChain currentEntryId={id} chain={fullChain} />
          </CardContent>
        </Card>
      )}

      {/* Dimension retag history (dimensions plan PR6): the immutable
          before/after trail. Stays Swedish (voucher detail surface). */}
      {dimensionsEnabled && retagLog.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Ändringshistorik för dimensioner</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {retagLog.map((row) => {
              const lineForRow = lines.find((l) => l.id === row.line_id)
              const fmt = (dims: Record<string, string>) => {
                const entries = Object.entries(dims ?? {}).sort(([a], [b]) => Number(a) - Number(b))
                return entries.length > 0 ? entries.map(([no, code]) => `${no}: ${code}`).join(', ') : '-'
              }
              return (
                <div key={row.id} className="text-sm border-b last:border-0 pb-3 last:pb-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground tabular-nums">{formatDate(row.created_at)}</span>
                    {lineForRow && <AccountNumber number={lineForRow.account_number} />}
                  </div>
                  <p className="tabular-nums">
                    <span className="text-muted-foreground line-through">{fmt(row.old_dimensions)}</span>
                    {' → '}
                    <span>{fmt(row.new_dimensions)}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{row.reason}</p>
                </div>
              )
            })}
          </CardContent>
        </Card>
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
        onConfirm={handleReverse}
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
    </div>
  )
}
