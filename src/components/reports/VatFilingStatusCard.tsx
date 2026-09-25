'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { vatFilingPeriodEnd, type VatFilingRecord } from '@/lib/vat/filing-record'

interface VatFilingStatusCardProps {
  periodType: 'monthly' | 'quarterly'
  year: number
  period: number
  /** Swedish period label, e.g. "Kvartal 2 2026". */
  periodLabel: string
  /** The period's filing record, or null when nothing is recorded. */
  record: VatFilingRecord | null
  canWrite: boolean
  /** Called after a mark or undo succeeded: the owner refetches the list. */
  onChanged: () => void
}

/**
 * Filing status of the selected period under "Lämna in" (issue #2746): shows
 * the recorded filing (through the Skatteverket connection or marked by
 * hand), or offers "Markera som inlämnad" for a declaration filed on
 * skatteverket.se. Recording the filing is free and sends nothing to
 * Skatteverket; it is what lets the page open the next period by default.
 *
 * Hidden while the period is still running: it cannot have been filed yet.
 */
export function VatFilingStatusCard({
  periodType,
  year,
  period,
  periodLabel,
  record,
  canWrite,
  onChanged,
}: VatFilingStatusCardProps) {
  const t = useTranslations('reports')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [filedOn, setFiledOn] = useState(() => todayIsoStockholm())
  const [reference, setReference] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const today = todayIsoStockholm()
  const periodEnd = vatFilingPeriodEnd(periodType, year, period)
  if (periodEnd >= today) return null
  // A declaration is filed after its period ends: the first selectable day is
  // the day after, matching the server's VAT_FILING_DATE_BEFORE_PERIOD_END rule.
  const earliestFilingDate = addDaysIso(periodEnd, 1)

  async function readError(res: Response, fallback: string): Promise<string> {
    const json = await res.json().catch(() => null)
    const message = json?.error?.message ?? (typeof json?.error === 'string' ? json.error : null)
    return typeof message === 'string' && message.length > 0 ? message : fallback
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
      setError(getErrorMessage(err) || t('vat_filing_failed'))
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
      setError(getErrorMessage(err) || t('vat_filing_unmark_failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-3 px-1">
        <h3 className="font-sans text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('vat_filing_section')}
        </h3>
        <div className="h-px flex-1 bg-border/60" />
      </div>

      {record ? (
        <div className="space-y-1 rounded-lg border border-success/40 bg-success/5 px-4 py-3 text-[13px] leading-6">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            {t('vat_filing_filed_on', { date: formatDate(record.filed_on) })}
          </p>
          <p className="text-muted-foreground">
            {record.source === 'skatteverket'
              ? t('vat_filing_source_skatteverket')
              : t('vat_filing_source_manual')}
          </p>
          {record.reference && (
            <p className="text-muted-foreground">
              {t('vat_filing_reference', { reference: record.reference })}
            </p>
          )}
          {record.source === 'manual' && canWrite && (
            <div className="pt-1">
              <Button variant="ghost" size="sm" onClick={unmark} loading={busy}>
                {t('vat_filing_unmark')}
              </Button>
            </div>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] leading-6 text-muted-foreground">{t('vat_filing_prompt')}</p>
          {canWrite && (
            <Button variant="outline" onClick={() => setOpen(true)}>
              {t('vat_filing_mark')}
            </Button>
          )}
        </div>
      )}

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
    </section>
  )
}
