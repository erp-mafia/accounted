'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import { announceSIEHoldsChanged } from '@/lib/import/sie-holds-client'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { formatDate, formatRowAmount, formatCurrency } from '@/lib/utils'
import type { FiscalPeriod } from '@/types'

interface FileOpeningBalance {
  filename: string | null
  lines: { account_number: string; debit_amount: number; credit_amount: number }[]
  total_debit: number
  total_credit: number
  /** The year before holds bokföring again: the IB follows it (PH 193). */
  previous_year_booked?: boolean
}

/**
 * A review acknowledgment changes metadata only; corrections use the entry UI.
 * A year without an IB verifikat had its IB derived from the preceding year,
 * whose import was undone (crm#1099): the dialog previews the IB the year's
 * own SIE file stated and can book it, unless the year before has been
 * imported again since (PH 193): then the year opens on its utgående
 * balanser and only the acknowledgment remains.
 */
export function SIEOpeningBalanceReview({ period, canManage }: { period: FiscalPeriod; canManage: boolean }) {
  const t = useTranslations('settings_bookkeeping')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [booking, setBooking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // undefined while loading; null when no import stored an IB for the year.
  const [file, setFile] = useState<FileOpeningBalance | null | undefined>(undefined)
  if (!period.opening_balance_review_token) return null
  // Known once the file preview has loaded; until then the year counts as
  // derived and the skeleton shows.
  const previousYearBooked = file?.previous_year_booked === true
  const derived = !period.opening_balance_entry_id && !previousYearBooked
  const balanced = !!file && lineBalance(file.lines).balanced
  const canBook = derived && canManage && balanced
  const busy = saving || booking

  async function loadFile() {
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}/opening-balance-review/sie-file`)
      const body = await response.json()
      setFile(response.ok ? (body.data as FileOpeningBalance | null) : null)
    } catch {
      setFile(null)
    }
  }

  function openDialog() {
    setError(null)
    setOpen(true)
    if (!period.opening_balance_entry_id) {
      setFile(undefined)
      void loadFile()
    }
  }

  async function acknowledge() {
    setSaving(true)
    setError(null)
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}/opening-balance-review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewToken: period.opening_balance_review_token, expectedEntryId: period.opening_balance_entry_id }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(getErrorMessage(body, { locale: locale, fallback: t('ib_review_failed') }))
      await invalidateReferenceData('ref:fiscal-periods')
      announceSIEHoldsChanged()
      toast({ title: t('ib_review_saved') })
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? getErrorMessage(err) : t('ib_review_failed'))
    } finally { setSaving(false) }
  }

  async function book() {
    setBooking(true)
    setError(null)
    try {
      const response = await fetch(`/api/bookkeeping/fiscal-periods/${period.id}/opening-balance-review/sie-file`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewToken: period.opening_balance_review_token }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        setError(body ? getErrorMessage(body, { locale, statusCode: response.status }) : t('ib_review_book_failed'))
        return
      }
      await invalidateReferenceData('ref:fiscal-periods')
      announceSIEHoldsChanged()
      toast({ title: t('ib_review_booked') })
      setOpen(false)
    } catch {
      setError(t('ib_review_book_failed'))
    } finally { setBooking(false) }
  }

  return <>
    <Button variant="outline" onClick={openDialog}>{t('ib_review_action')}</Button>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value) }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ib_review_title', { name: period.name })}</DialogTitle>
          <DialogDescription>{previousYearBooked ? t('ib_review_description_previous_booked') : derived ? t('ib_review_description_derived') : t('ib_review_description')}</DialogDescription>
        </DialogHeader>
        {derived && file === undefined && <div className="space-y-2" aria-hidden>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>}
        {derived && file && <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('ib_review_file_intro', { filename: file.filename ?? '' })}</p>
          <div className="max-h-64 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('ib_review_col_account')}</TableHead>
                  <TableHead className="text-right">{t('ib_review_col_debit')}</TableHead>
                  <TableHead className="text-right">{t('ib_review_col_credit')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {file.lines.map(line => <TableRow key={line.account_number}>
                  <TableCell className="tabular-nums">{line.account_number}</TableCell>
                  <TableCell className="text-right tabular-nums">{line.debit_amount ? formatRowAmount(line.debit_amount) : ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{line.credit_amount ? formatRowAmount(line.credit_amount) : ''}</TableCell>
                </TableRow>)}
                <TableRow>
                  <TableCell className="font-medium">{t('ib_review_col_total')}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatCurrency(file.total_debit)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{formatCurrency(file.total_credit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p className="text-sm text-muted-foreground">
            {balanced ? t('ib_review_file_book_help', { date: formatDate(period.period_start) }) : t('ib_review_file_unbalanced')}
          </p>
        </div>}
        {derived && file === null && <p className="text-sm text-muted-foreground">{t('ib_review_file_missing')}</p>}
        <div className="flex flex-wrap gap-3">
          {period.opening_balance_entry_id && <Button asChild variant="outline">
            <Link href={`/bookkeeping/${period.opening_balance_entry_id}`} target="_blank" rel="noopener noreferrer">{t('ib_review_entry')}</Link>
          </Button>}
          {derived && file !== undefined && !balanced && <Button asChild variant="outline">
            <Link href="/import?mode=csv_data" target="_blank" rel="noopener noreferrer">{t('ib_review_manual')}</Link>
          </Button>}
          <Button asChild variant="outline">
            <Link href={`/import?mode=sie&job=${period.opening_balance_review_import_id}`} target="_blank" rel="noopener noreferrer">{t('ib_review_import')}</Link>
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{derived || previousYearBooked ? t('ib_review_confirm_help_derived') : t('ib_review_confirm_help')}</p>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t('fy_confirm_cancel')}</Button>
          {canManage && <Button variant={canBook ? 'outline' : 'default'} disabled={busy} onClick={acknowledge}>
            {saving ? t('ib_review_saving') : t('ib_review_confirm')}
          </Button>}
          {canBook && <Button loading={booking} disabled={saving} onClick={book}>{t('ib_review_book')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
