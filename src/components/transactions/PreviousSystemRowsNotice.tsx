'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ToastAction } from '@/components/ui/toast'
import { useToast } from '@/components/ui/use-toast'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useFormat } from '@/lib/hooks/use-format'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'

interface PreviousSystemRowsSummary {
  companyId: string
  cutoff: string
  count: number
  first_date: string
  last_date: string
}

interface PreviousSystemRowsNoticeOptions {
  /**
   * The page's count of rows to book: the rows are asked for again whenever
   * it changes (first load, a sync, a booking), so the sentence never counts
   * a row that has left.
   */
  openRowCount: number
  /** The rows just marked: the page folds them out of the list. */
  onMarked: (transactionIds: string[]) => void
  /** Opens Alla, Ignorerade, where each marked row can be restored. */
  onShowIgnored: () => void
}

/**
 * The attention sentence for bank rows from before the company's SIE import
 * ends (crm#1954): "24 bankrader är från tiden före 1 oktober, som redan
 * finns i bokföringen från ditt tidigare system. Markera dem som bokförda
 * där". The relink after the import pairs a row with an imported verifikat
 * only when one bank line has its amount, so a row the old system booked
 * split stays among the rows to book, one click from a double booking.
 *
 * The action opens a small confirm dialog (design convention 10) that names
 * the last imported verifikat's date and the rows' dates; its confirm sets
 * the ignore flag on exactly the rows counted
 * (POST /api/transactions/previous-system). They leave the list, stay under
 * Alla, Ignorerade, and are restored one by one the usual way.
 *
 * Returns null when there is nothing to say, so the page can give its single
 * attention line (design convention 6) to something else. Never asked for a
 * viewer, who could not act on it.
 */
export function usePreviousSystemRowsNotice({
  openRowCount,
  onMarked,
  onShowIgnored,
}: PreviousSystemRowsNoticeOptions): React.ReactNode | null {
  const t = useTranslations('previous_system_rows')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const format = useFormatter()
  const { formatDateLong } = useFormat()
  const { toast } = useToast()
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const companyId = company?.id ?? null

  const [summary, setSummary] = useState<PreviousSystemRowsSummary | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [marking, setMarking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  // A newer question owns the answer: a booking while one is in flight must
  // not let the older count land after the newer one.
  const generationRef = useRef(0)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    const generation = ++generationRef.current
    if (!companyId || !canWrite || openRowCount === 0) {
      setSummary(null)
      return
    }
    try {
      const response = await fetch('/api/transactions/previous-system')
      if (!response.ok) return
      const payload = (await response.json()) as {
        data?: { cutoff: string | null; count: number; first_date: string | null; last_date: string | null }
      }
      if (generation !== generationRef.current) return
      const data = payload.data
      setSummary(
        data?.cutoff && data.count > 0 && data.first_date && data.last_date
          ? { companyId, cutoff: data.cutoff, count: data.count, first_date: data.first_date, last_date: data.last_date }
          : null,
      )
    } catch {
      // Advisory: without an answer the line is not shown, and the rows stay
      // in the list as they were.
    }
  }, [companyId, canWrite, openRowCount])

  useEffect(() => {
    void load()
  }, [load])

  const mark = useCallback(async () => {
    if (!summary || inFlight.current) return
    inFlight.current = true
    setMarking(true)
    setFailure(null)
    try {
      const response = await fetch('/api/transactions/previous-system', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cutoff: summary.cutoff }),
      })
      const body = (await response.json().catch(() => null)) as { data?: { transaction_ids?: string[] } } | null
      if (!response.ok) {
        setFailure(getErrorMessage(body, { locale, statusCode: response.status, fallback: t('failed') }))
        // The import moved under the line: read it again for the sentence.
        if (response.status === 409) void load()
        return
      }
      const ids = body?.data?.transaction_ids ?? []
      setConfirming(false)
      setSummary(null)
      if (ids.length === 0) {
        // Every row left the selection before the write (booked, linked):
        // the list changed under the line, so it is read again.
        void load()
        return
      }
      // The page's count drops as the rows fold out, which reads the line again.
      onMarked(ids)
      toast({
        title: t('done_title', { count: ids.length }),
        action: (
          <ToastAction altText={t('show_ignored_alt')} onClick={onShowIgnored}>
            {t('show_ignored')}
          </ToastAction>
        ),
      })
    } catch {
      setFailure(t('failed'))
    } finally {
      inFlight.current = false
      setMarking(false)
    }
  }, [summary, locale, t, load, onMarked, onShowIgnored, toast])

  if (!summary || summary.companyId !== companyId) return null

  // "före 1 oktober": the day after the imported books end, with the year
  // only when it is not this year.
  const dayAfter = addDaysIso(summary.cutoff, 1)
  const sameYear = dayAfter.slice(0, 4) === todayIsoStockholm().slice(0, 4)
  const dateLabel = format.dateTime(new Date(`${dayAfter}T00:00:00Z`), {
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  })

  return (
    <>
      <AttnLine
        action={{
          label: t('action', { count: summary.count }),
          onClick: () => {
            setFailure(null)
            setConfirming(true)
          },
        }}
      >
        {t('line', { count: summary.count, date: dateLabel })}
      </AttnLine>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (marking) return
          if (!open) setConfirming(false)
        }}
      >
        <DialogContent size="confirm">
          <DialogHeader>
            <DialogTitle>{t('confirm_title', { count: summary.count })}</DialogTitle>
            <DialogDescription>
              {t('confirm_body', {
                count: summary.count,
                cutoff: formatDateLong(summary.cutoff),
                first: formatDateLong(summary.first_date),
                last: formatDateLong(summary.last_date),
                same: summary.first_date === summary.last_date ? 'yes' : 'no',
              })}
            </DialogDescription>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">{t('confirm_restore', { count: summary.count })}</p>
          <DialogFooter>
            <DialogConsequence role={failure ? 'alert' : undefined} className={failure ? 'text-destructive' : undefined}>
              {failure ?? t('consequence')}
            </DialogConsequence>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={marking}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={() => void mark()} loading={marking}>
              {t('confirm_cta', { count: summary.count })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
