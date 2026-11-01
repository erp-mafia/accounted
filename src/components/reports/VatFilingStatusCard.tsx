'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatDate } from '@/lib/utils'
import { addDaysIso, hasEnded, todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  vatFilingPeriodEnd,
  type VatFilingPeriodType,
  type VatFilingRecord,
} from '@/lib/vat/filing-record'

interface VatFilingStatusCardProps {
  periodType: VatFilingPeriodType
  /** Calendar year of the period; for yearly, the year the räkenskapsår ends. */
  year: number
  period: number
  /** Month (1-12) the räkenskapsår ends: places a yearly period. */
  fiscalYearEndMonth: number
  /** Period label, e.g. "Kvartal 2 2026" or "Räkenskapsår 2025/2026". */
  periodLabel: string
  /** The period's filing record, or null when nothing is recorded. */
  record: VatFilingRecord | null
  canWrite: boolean
  /** Called after a mark or undo succeeded: the owner refetches the list. */
  onChanged: () => void
}

/**
 * Filing status of the selected period in the "Lämna in" action row (issues
 * #2746, #2786), for every cadence including helårsmoms: the recorded filing
 * (through the Skatteverket connection or marked by hand) as one muted line,
 * or the "Markera som inlämnad" button for a declaration filed on
 * skatteverket.se. Recording the filing is free and sends nothing to
 * Skatteverket; it is what lets the page open the next period by default.
 * Why it exists is explained behind the step's "?", not here.
 *
 * Hidden while the period is still running: it cannot have been filed yet.
 */
export function VatFilingStatusCard({
  periodType,
  year,
  period,
  fiscalYearEndMonth,
  periodLabel,
  record,
  canWrite,
  onChanged,
}: VatFilingStatusCardProps) {
  const t = useTranslations('reports')
  const tCommon = useTranslations('common')
  const errorLocale = useLocale() as ErrorLocale
  const [open, setOpen] = useState(false)
  const [filedOn, setFiledOn] = useState(() => todayIsoStockholm())
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const today = todayIsoStockholm()
  const periodEnd = vatFilingPeriodEnd(periodType, year, period, fiscalYearEndMonth)
  if (!hasEnded(periodEnd, today)) return null
  // A declaration is filed after its period ends: the first selectable day is
  // the day after, matching the server's VAT_FILING_DATE_BEFORE_PERIOD_END rule.
  const earliestFilingDate = addDaysIso(periodEnd, 1)

  async function readError(res: Response, fallback: string): Promise<string> {
    const json = await res.json().catch(() => null)
    return getErrorMessage(json, { locale: errorLocale, fallback })
  }

  async function mark() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/reports/vat-declaration/filings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_type: periodType,
          year,
          period,
          filed_on: filedOn,
          reference: reference.trim() || null,
        }),
      })
      if (!res.ok) {
        setError(await readError(res, t('vat_filing_failed')))
        return
      }
      setOpen(false)
      setReference('')
      onChanged()
    } catch (err) {
      setError(getErrorMessage(err, { locale: errorLocale, fallback: t('vat_filing_failed') }))
    } finally {
      setBusy(false)
    }
  }

  async function unmark() {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        period_type: periodType,
        year: String(year),
        period: String(period),
      })
      const res = await fetch(`/api/reports/vat-declaration/filings?${params.toString()}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        setError(await readError(res, t('vat_filing_unmark_failed')))
        return
      }
      onChanged()
    } catch (err) {
      setError(getErrorMessage(err, { locale: errorLocale, fallback: t('vat_filing_unmark_failed') }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {record ? (
        // Filed is a normal state: muted text in the row (convention 12),
        // never a green box.
        <p className="text-[13px] leading-5 text-muted-foreground tabular-nums">
          {t('vat_filing_filed_on', { date: formatDate(record.filed_on) })}
          {' · '}
          {record.source === 'skatteverket'
            ? t('vat_filing_source_skatteverket')
            : t('vat_filing_source_manual')}
          {record.reference && (
            <>
              {' · '}
              {t('vat_filing_reference', { reference: record.reference })}
            </>
          )}
          {record.source === 'manual' && canWrite && (
            <>
              {' · '}
              <button type="button" className={QUIET_LINK_CLASS} onClick={unmark} disabled={busy}>
                {t('vat_filing_unmark')}
              </button>
            </>
          )}
          {error && <span className="text-destructive">{` ${error}`}</span>}
        </p>
      ) : canWrite ? (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          {t('vat_filing_mark')}
        </Button>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return
          setOpen(next)
          if (!next) setError(null)
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t('vat_filing_dialog_title', { period: periodLabel })}</DialogTitle>
            <DialogDescription>{t('vat_filing_dialog_body')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="vat-filing-date">{t('vat_filing_date')}</Label>
              <Input
                id="vat-filing-date"
                type="date"
                value={filedOn}
                min={earliestFilingDate}
                max={today}
                onChange={(e) => setFiledOn(e.target.value)}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vat-filing-reference">{t('vat_filing_reference_label')}</Label>
              <Input
                id="vat-filing-reference"
                value={reference}
                maxLength={200}
                placeholder={t('vat_filing_reference_placeholder')}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>
            {error && <p className="text-[13px] text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={mark} disabled={filedOn.length !== 10} loading={busy}>
              {t('vat_filing_mark')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
