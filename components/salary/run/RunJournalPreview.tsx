'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { Calculator, Loader2 } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

export interface EntryPreviewLine {
  account_number: string
  line_description: string
  debit_amount: number | null
  credit_amount: number | null
}

export interface EntryPreview {
  description: string
  lines: EntryPreviewLine[]
}

export interface PreviewData {
  // True when the entries are the ACTUAL posted verifikat of a booked run
  // (the preview route returns those instead of a recomputed projection,
  // which could contradict vouchers booked under earlier rules).
  booked?: boolean
  salaryEntry: EntryPreview | null
  avgifterEntry: EntryPreview | null
  vacationEntry: EntryPreview | null
  pensionEntry?: EntryPreview | null
}

interface RunJournalPreviewProps {
  preview: PreviewData
  // When provided (draft + write access), a "Beräkna om" button renders on
  // the kicker line: recalculation sits on the output it refreshes.
  onRecalculate?: () => void
  recalculating?: boolean
}

export function RunJournalPreview({ preview, onRecalculate, recalculating }: RunJournalPreviewProps) {
  const t = useTranslations('salary_run')

  const entries = [
    preview.salaryEntry,
    preview.avgifterEntry,
    preview.vacationEntry,
    preview.pensionEntry,
  ].filter(Boolean) as EntryPreview[]

  return (
    <DetailSection
      kicker={preview.booked ? t('journal_booked_title') : t('journal_preview_title')}
      aside={
        onRecalculate ? (
          <Button variant="outline" size="sm" onClick={onRecalculate} disabled={recalculating} className="-my-1">
            {recalculating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="mr-2 h-4 w-4" />
            )}
            {t('action_recalculate')}
          </Button>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('journal_preview_nollkorning')}</p>
      ) : (
        <div className="space-y-6">
          {entries.map((entry, idx) => (
            <div key={idx}>
              <h4 className="text-sm font-medium">{entry.description}</h4>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={cn(TH_CLASS, 'pl-0')}>{t('journal_th_account')}</th>
                      <th className={TH_CLASS}>{t('journal_th_description')}</th>
                      <th className={cn(TH_CLASS, 'text-right')}>{t('journal_th_debit')}</th>
                      <th className={cn(TH_CLASS, 'pr-0 text-right')}>{t('journal_th_credit')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map((line, li) => (
                      <tr key={li}>
                        <td className={cn(TD_CLASS, 'pl-0 tabular-nums font-mono')}>{line.account_number}</td>
                        <td className={cn(TD_CLASS, 'text-muted-foreground')}>{line.line_description}</td>
                        <td className={cn(TD_CLASS, 'text-right tabular-nums')}>
                          {line.debit_amount ? formatCurrency(line.debit_amount) : ''}
                        </td>
                        <td className={cn(TD_CLASS, 'pr-0 text-right tabular-nums')}>
                          {line.credit_amount ? formatCurrency(line.credit_amount) : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  )
}
