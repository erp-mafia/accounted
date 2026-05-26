'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ChevronDown, ChevronRight, Paperclip, AlertTriangle, Loader2, BookOpen, X, Copy, Lock } from 'lucide-react'
import { formatDate } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { AccountNumber } from '@/components/ui/account-number'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import AttachmentPreviewSheet from '@/components/bookkeeping/AttachmentPreviewSheet'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { JournalEntry, JournalEntryLine } from '@/types'

const NEEDS_ATTACHMENT = new Set([
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
])

interface Props {
  periodId?: string
}

export default function JournalEntryList({ periodId }: Props) {
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const t = useTranslations('journal_list')
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [committingId, setCommittingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  const [showMissingOnly, setShowMissingOnly] = useState(false)
  const [correctionEntry, setCorrectionEntry] = useState<JournalEntry | null>(null)
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'voucher_asc' | 'voucher_desc'>('date_desc')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromInput, setDateFromInput] = useState('')
  const [dateToInput, setDateToInput] = useState('')
  const pageSize = 20

  const normalizeDate = (v: string): string | null => {
    const trimmed = v.trim()
    if (!trimmed) return null
    // YYYY
    if (/^\d{4}$/.test(trimmed)) {
      const y = parseInt(trimmed, 10)
      if (y < 1900 || y > 2100) return null
      return `${trimmed}-01-01`
    }
    // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(trimmed)) {
      const [y, m] = trimmed.split('-').map(Number)
      if (y < 1900 || y > 2100 || m < 1 || m > 12) return null
      return `${trimmed}-01`
    }
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(trimmed + 'T00:00:00')
      if (isNaN(d.getTime())) return null
      // Verify the date didn't roll over (e.g. 2024-02-31 → March)
      const [y, m, day] = trimmed.split('-').map(Number)
      if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null
      return trimmed
    }
    return null
  }

  const applyDateFilter = () => {
    const fromVal = dateFromInput.trim()
    const toVal = dateToInput.trim()
    const nextFrom = fromVal === '' ? '' : normalizeDate(fromVal) ?? dateFrom
    const nextTo = toVal === '' ? '' : normalizeDate(toVal) ?? dateTo
    setDateFromInput(nextFrom)
    setDateToInput(nextTo)
    if (nextFrom !== dateFrom || nextTo !== dateTo) {
      setDateFrom(nextFrom)
      setDateTo(nextTo)
      setPage(0)
    }
  }

  const fetchAttachmentCounts = useCallback(async (entryIds: string[]) => {
    if (entryIds.length === 0) return
    try {
      const res = await fetch(
        `/api/documents/counts?journal_entry_ids=${entryIds.join(',')}`
      )
      const { data } = await res.json()
      setAttachmentCounts(data || {})
    } catch {
      // Non-critical — silently ignore
    }
  }, [])

  async function fetchEntries() {
    setLoading(true)
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
      sort_by: sortBy,
    })
    if (periodId) params.set('period_id', periodId)
    if (dateFrom) params.set('date_from', dateFrom)
    if (dateTo) params.set('date_to', dateTo)

    const res = await fetch(`/api/bookkeeping/journal-entries?${params}`)
    if (!res.ok) {
      setLoading(false)
      return
    }
    const { data, count: total } = await res.json()
    const loadedEntries = data || []
    setEntries(loadedEntries)
    setCount(total || 0)
    setLoading(false)

    // Fetch attachment counts for the loaded entries
    const ids = loadedEntries.map((e: JournalEntry) => e.id)
    fetchAttachmentCounts(ids)
  }

  useEffect(() => {
    fetchEntries()
  }, [periodId, page, sortBy, dateFrom, dateTo])

  const handleAttachmentCountChange = useCallback((entryId: string, count: number) => {
    setAttachmentCounts((prev) => ({ ...prev, [entryId]: count }))
  }, [])

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  const handleCommit = async (entryId: string) => {
    setCommittingId(entryId)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entryId}/commit`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const posted = result.data
        toast({
          title: t('toast_posted_title'),
          description: t('toast_posted_description', { voucher: `${posted?.voucher_series ?? ''}${posted?.voucher_number ?? ''}` }),
        })
        await fetchEntries()
      } else {
        toast({ title: t('toast_post_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setCommittingId(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        </CardContent>
      </Card>
    )
  }

  if (entries.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <div className="p-4 rounded-full bg-muted mb-4">
            <BookOpen className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium mb-1">{t('empty_title')}</h3>
          <p className="text-sm text-muted-foreground text-center max-w-sm">
            {t('empty_description')}
          </p>
        </CardContent>
      </Card>
    )
  }

  const filteredEntries = showMissingOnly
    ? entries.filter(
        (e) =>
          NEEDS_ATTACHMENT.has(e.source_type) &&
          !attachmentCounts[e.id] &&
          e.status === 'posted'
      )
    : entries

  return (
    <div className="space-y-4">
      {/* Filters and sorting */}
      <div className="space-y-3 sm:space-y-0 sm:flex sm:items-center sm:gap-4 sm:flex-wrap">
        <div className="flex items-center justify-between sm:justify-start gap-2">
          <div className="flex items-center gap-2">
            <Switch
              id="missing-attachments"
              checked={showMissingOnly}
              onCheckedChange={setShowMissingOnly}
            />
            <Label htmlFor="missing-attachments" className="text-sm cursor-pointer">
              {t('show_missing')}
            </Label>
            {showMissingOnly && (
              <Badge variant="secondary" className="text-xs">
                {filteredEntries.length}
              </Badge>
            )}
          </div>
        </div>
        <Select value={sortBy} onValueChange={(v) => { setSortBy(v as typeof sortBy); setPage(0) }}>
          <SelectTrigger className="h-8 w-auto gap-1.5 text-xs sm:w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_desc">{t('sort_date_desc')}</SelectItem>
            <SelectItem value="date_asc">{t('sort_date_asc')}</SelectItem>
            <SelectItem value="voucher_asc">{t('sort_voucher_asc')}</SelectItem>
            <SelectItem value="voucher_desc">{t('sort_voucher_desc')}</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Input
            type="text"
            placeholder={t('date_from_placeholder')}
            value={dateFromInput}
            onChange={(e) => setDateFromInput(e.target.value)}
            onBlur={() => {
              const v = dateFromInput.trim()
              if (v === '') return
              const normalized = normalizeDate(v)
              if (normalized) setDateFromInput(normalized)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyDateFilter()
              }
            }}
            className="h-8 flex-1 sm:flex-none sm:w-[145px] text-xs"
          />
          <Input
            type="text"
            placeholder={t('date_to_placeholder')}
            value={dateToInput}
            onChange={(e) => setDateToInput(e.target.value)}
            onBlur={() => {
              const v = dateToInput.trim()
              if (v === '') return
              const normalized = normalizeDate(v)
              if (normalized) setDateToInput(normalized)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                applyDateFilter()
              }
            }}
            className="h-8 flex-1 sm:flex-none sm:w-[145px] text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs shrink-0"
            onClick={applyDateFilter}
          >
            {t('filter')}
          </Button>
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => { setDateFrom(''); setDateTo(''); setDateFromInput(''); setDateToInput(''); setPage(0) }}
              className="p-1 rounded-sm hover:bg-muted text-muted-foreground shrink-0"
              title={t('clear_date_filter')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        {filteredEntries.map((entry) => {
          const isExpanded = expandedId === entry.id
          const lines = (entry.lines || []) as JournalEntryLine[]

          return (
            <Card key={entry.id}>
              <button
                onClick={() => toggleExpand(entry.id)}
                aria-expanded={isExpanded}
                className="w-full p-4 text-left hover:bg-muted/50 transition-colors min-h-[44px]"
              >
                {/* Desktop: single row */}
                <div className="hidden sm:flex items-center gap-3 flex-1">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  )}
                  <Link
                    href={`/bookkeeping/${entry.id}`}
                    className="font-mono text-sm text-primary hover:underline w-16"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {entry.voucher_series}{entry.voucher_number}
                  </Link>
                  <span className="text-sm text-muted-foreground tabular-nums w-24">
                    {formatDate(entry.entry_date)}
                  </span>
                  {entry.out_of_period && (
                    <Badge
                      variant="outline"
                      className="text-xs font-normal shrink-0"
                      title={t('out_of_period_tooltip')}
                    >
                      {t('out_of_period_label')}
                    </Badge>
                  )}
                  {(entry.status === 'reversed' || entry.status === 'draft' || entry.source_type === 'storno' || entry.source_type === 'correction') && (
                    <JournalEntryStatusBadge entry={entry} showStatus={entry.status === 'reversed' || entry.status === 'draft'} />
                  )}
                  <span className="flex-1 truncate">{entry.description}</span>
                  {attachmentCounts[entry.id] ? (
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 mr-1 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('view_attachments')}
                        title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setPreviewEntryId(entry.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            setPreviewEntryId(entry.id)
                          }
                        }}
                      >
                        <span className="flex items-center gap-0.5">
                          <Paperclip className="h-3.5 w-3.5" />
                          <span className="text-xs">{attachmentCounts[entry.id]}</span>
                        </span>
                      </span>
                    </Button>
                  ) : (
                    NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                      <span className="mr-1" title={t('missing_attachment_tooltip')}>
                        <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />
                      </span>
                    )
                  )}
                </div>
                {/* Mobile: two rows */}
                <div className="sm:hidden">
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    )}
                    <Link
                      href={`/bookkeeping/${entry.id}`}
                      className="font-mono text-sm text-primary hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {entry.voucher_series}{entry.voucher_number}
                    </Link>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {formatDate(entry.entry_date)}
                    </span>
                    {entry.out_of_period && (
                      <Badge
                        variant="outline"
                        className="text-xs font-normal shrink-0"
                        title={t('out_of_period_tooltip_mobile')}
                      >
                        {t('out_of_period_label')}
                      </Badge>
                    )}
                    {(entry.status === 'reversed' || entry.status === 'draft' || entry.source_type === 'storno' || entry.source_type === 'correction') && (
                      <JournalEntryStatusBadge entry={entry} showStatus={entry.status === 'reversed' || entry.status === 'draft'} />
                    )}
                    <span className="ml-auto flex items-center gap-1">
                      {attachmentCounts[entry.id] ? (
                        <Button
                          asChild
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                        >
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={t('view_attachments')}
                            title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setPreviewEntryId(entry.id)
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                e.stopPropagation()
                                setPreviewEntryId(entry.id)
                              }
                            }}
                          >
                            <span className="flex items-center gap-0.5">
                              <Paperclip className="h-3.5 w-3.5" />
                              <span className="text-xs">{attachmentCounts[entry.id]}</span>
                            </span>
                          </span>
                        </Button>
                      ) : (
                        NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                          <span title={t('missing_attachment_tooltip')}>
                            <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />
                          </span>
                        )
                      )}
                    </span>
                  </div>
                  <p className="mt-1 ml-6 text-sm truncate">{entry.description}</p>
                </div>
              </button>

              {isExpanded && (
                <CardContent className="pt-0 pb-4">
                  {lines.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">{t('no_lines')}</p>
                  ) : (
                  <>
                    <div className="space-y-3">
                      {lines
                        .sort((a, b) => a.sort_order - b.sort_order)
                        .map((line) => {
                          const accountName = getAccountDescription(line.account_number)?.name
                          const desc = line.line_description
                          const showDesc = desc
                            && desc.toLowerCase() !== accountName?.toLowerCase()
                            && desc.toLowerCase() !== entry.description?.toLowerCase()
                          return (
                          <div key={line.id} className="rounded-lg border p-3 space-y-1.5">
                            <div className="text-sm">
                              <AccountNumber number={line.account_number} showName />
                            </div>
                            {showDesc && (
                              <p className="text-xs text-muted-foreground">{desc}</p>
                            )}
                            <div className="flex justify-between items-center pt-1 border-t text-sm">
                              <span className="text-muted-foreground">
                                {Number(line.debit_amount) > 0 ? t('debit') : t('credit')}
                              </span>
                              <div className="text-right">
                                <span className="font-mono tabular-nums font-medium">
                                  {Number(line.debit_amount) > 0
                                    ? Number(line.debit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })
                                    : Number(line.credit_amount).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                                </span>
                                {line.currency && line.currency !== 'SEK' && line.amount_in_currency != null && (
                                  <span className="block text-xs text-muted-foreground font-mono tabular-nums">
                                    {Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} {line.currency}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          )
                        })}
                      <div className="rounded-lg bg-muted/50 p-3 text-sm font-semibold space-y-1">
                        <div className="flex justify-between">
                          <span>{t('sum_debit')}</span>
                          <span className="font-mono tabular-nums">{lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>{t('sum_credit')}</span>
                          <span className="font-mono tabular-nums">{lines.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    </div>
                  </>
                  )}

                  {entry.notes && (
                    <p className="mt-3 text-xs text-muted-foreground italic px-1">
                      {entry.notes}
                    </p>
                  )}

                  <JournalEntryAttachments
                    journalEntryId={entry.id}
                    onCountChange={(c) => handleAttachmentCountChange(entry.id, c)}
                  />

                  <div className="mt-4 pt-3 border-t flex flex-col sm:flex-row gap-2">
                    {entry.status === 'draft' && (
                      <Button
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => handleCommit(entry.id)}
                        disabled={!canWrite || committingId === entry.id}
                        title={!canWrite ? t('read_only_tooltip') : undefined}
                      >
                        {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : committingId === entry.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {t('post')}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="w-full sm:w-auto" asChild>
                      <Link href={`/bookkeeping/${entry.id}`}>{t('show_details')}</Link>
                    </Button>
                    {entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => setCorrectionEntry(entry)}
                      >
                        {t('create_correction')}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full sm:w-auto"
                      onClick={() => router.push(`/bookkeeping?copy_from=${entry.id}`)}
                    >
                      <Copy className="mr-2 h-4 w-4" />
                      {t('copy')}
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          )
        })}
      </div>

      {/* Correction dialog */}
      {correctionEntry && (
        <CorrectionEntryDialog
          entry={correctionEntry}
          open={!!correctionEntry}
          onOpenChange={(open) => { if (!open) setCorrectionEntry(null) }}
          onCorrected={() => { setCorrectionEntry(null); fetchEntries() }}
        />
      )}

      {/* Attachment preview sheet */}
      <AttachmentPreviewSheet
        entryId={previewEntryId}
        open={previewEntryId !== null}
        onOpenChange={(open) => { if (!open) setPreviewEntryId(null) }}
      />

      {/* Pagination */}
      {count > pageSize && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {t('previous')}
          </Button>
          <span className="text-sm text-muted-foreground self-center">
            {t('page_of', { page: page + 1, total: Math.ceil(count / pageSize) })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={(page + 1) * pageSize >= count}
            onClick={() => setPage(page + 1)}
          >
            {t('next')}
          </Button>
        </div>
      )}
    </div>
  )
}
