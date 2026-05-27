'use client'

import { useState, useEffect, useCallback, use } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AccountNumber } from '@/components/ui/account-number'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, ArrowLeft, Paperclip, AlertTriangle, Lock, MessageSquare, Pencil, Check, X, Copy } from 'lucide-react'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import JournalEntryStatusBadge, { useSourceTypeLabels } from '@/components/bookkeeping/JournalEntryStatusBadge'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import CorrectionChain from '@/components/bookkeeping/CorrectionChain'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { JournalEntry, JournalEntryLine } from '@/types'

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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [isCommitting, setIsCommitting] = useState(false)
  const [isLastInSeries, setIsLastInSeries] = useState(false)
  const [attachmentCount, setAttachmentCount] = useState(0)
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  const fetchData = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${id}/chain`)
      if (!res.ok) {
        const { error: msg } = await res.json()
        setError(msg || t('error_load_failed'))
        return
      }
      const { data } = await res.json()
      setEntry(data.entry)
      setChain(data.chain)
      setIsLastInSeries(data.is_last_in_series ?? false)
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

  const canCorrect =
    entry.status === 'posted' &&
    entry.source_type !== 'storno' &&
    entry.source_type !== 'correction'

  // Include current entry in the chain for the visualization
  const fullChain = [entry, ...chain]

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
            <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight font-mono">
              {formatVoucher(entry)}
            </h1>
            <JournalEntryStatusBadge entry={entry} />
          </div>
          <p className="text-muted-foreground">{entry.description}</p>
        </div>

        {(entry.status === 'posted' || entry.status === 'draft') && (
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
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
            {canCorrect && (
              <Button
                variant="outline"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => setShowCorrection(true)}
                disabled={!canWrite}
                title={!canWrite ? t('read_only_tooltip') : undefined}
              >
                {!canWrite && <Lock className="mr-2 h-4 w-4" />}
                {t('create_correction')}
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
                <span>{new Date(entry.committed_at).toLocaleDateString('sv-SE')}</span>
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
            {/* Notes — always editable (internal metadata, not BFL verifikation content) */}
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
            <div className="flex items-center gap-2">
              {attachmentCount > 0 ? (
                <>
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <span>{t('attachments_count', { count: attachmentCount })}</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-warning-foreground" />
                  <span className="text-muted-foreground">{t('no_attachments')}</span>
                </>
              )}
            </div>
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
                    : '—'}
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
                      <td className="py-2 text-muted-foreground">{line.line_description || ''}</td>
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
                    <div className="text-sm"><AccountNumber number={line.account_number} showName /></div>
                    {line.line_description && (
                      <p className="text-xs text-muted-foreground truncate">{line.line_description}</p>
                    )}
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
    </div>
  )
}
