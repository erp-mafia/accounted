'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Calculator, Loader2 } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

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
  salaryEntry: EntryPreview | null
  avgifterEntry: EntryPreview | null
  vacationEntry: EntryPreview | null
  pensionEntry?: EntryPreview | null
}

interface RunJournalPreviewProps {
  preview: PreviewData
  // When provided (draft + write access), a "Beräkna om" button renders in the
  // header — recalculation sits on the output it refreshes.
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">{t('journal_preview_title')}</CardTitle>
        {onRecalculate && (
          <Button variant="outline" size="sm" onClick={onRecalculate} disabled={recalculating}>
            {recalculating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="mr-2 h-4 w-4" />
            )}
            {t('action_recalculate')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('journal_preview_nollkorning')}</p>
        ) : (
          entries.map((entry, idx) => (
            <div key={idx} className="space-y-2">
              <h4 className="text-sm font-medium">{entry.description}</h4>
              <table className="w-full text-xs">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b">
                    <th className="text-left py-1">{t('journal_th_account')}</th>
                    <th className="text-left py-1">{t('journal_th_description')}</th>
                    <th className="text-right py-1">{t('journal_th_debit')}</th>
                    <th className="text-right py-1">{t('journal_th_credit')}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((line, li) => (
                    <tr key={li} className="border-t border-border">
                      <td className="py-1.5 tabular-nums font-mono">{line.account_number}</td>
                      <td className="py-1.5 text-muted-foreground">{line.line_description}</td>
                      <td className="py-1.5 text-right tabular-nums">
                        {line.debit_amount ? formatCurrency(line.debit_amount) : ''}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {line.credit_amount ? formatCurrency(line.credit_amount) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
