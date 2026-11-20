'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection } from '@/components/ui/detail-section'
import { HelpPopover } from '@/components/ui/help-popover'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { CalculatorIcon, DocumentTextIcon } from '@/components/icons'
import { formatRunAmount } from './types'

export interface EntryPreviewLine {
  account_number: string
  line_description: string
  debit_amount: number | null
  credit_amount: number | null
}

export interface EntryPreview {
  description: string
  lines: EntryPreviewLine[]
  // Booked runs only: the posted verifikat this entry IS, so its voucher label
  // can be a link to it. The label used to be concatenated into `description`,
  // which named a verifikat the reader had no way to open.
  journal_entry_id?: string | null
  voucher?: string | null
  // The preview route's balance assertion (absent on booked runs, whose
  // vouchers the DB trigger already proved balanced). False means the
  // projection and the booking rules have diverged: surfaced, never hidden.
  balanced?: boolean
  difference?: number
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
  // Booked runs: the Lönesammanställning PDF, the underlag filed with the
  // vouchers listed below, downloads from the same kicker line.
  underlagHref?: string
  // The run's taxable förmånsvärden (sum of salary_run_employees.
  // benefit_values). They book no line of their own (salary-entries.ts), so
  // the preview says where they went instead of leaving the reader to look
  // for a 73xx account (crm#1354).
  benefitValues?: number
}

export function RunJournalPreview({ preview, onRecalculate, recalculating, underlagHref, benefitValues }: RunJournalPreviewProps) {
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
          <Button variant="outline" onClick={onRecalculate} loading={recalculating} className="-my-1">
            {!recalculating && <CalculatorIcon className="h-4 w-4" />}
            {t('action_recalculate')}
          </Button>
        ) : underlagHref ? (
          <Button variant="outline" asChild className="-my-1">
            <a href={underlagHref} target="_blank" rel="noopener noreferrer" title={t('journal_download_underlag_title')}>
              <DocumentTextIcon className="mr-2 h-4 w-4" />
              {t('journal_download_underlag')}
            </a>
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
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-sm font-medium">{entry.description}</h4>
                {entry.journal_entry_id && entry.voucher && (
                  <Link
                    href={`/bookkeeping/${entry.journal_entry_id}`}
                    aria-label={t('journal_open_voucher', { voucher: entry.voucher })}
                    className="shrink-0 text-[13px] tabular-nums text-muted-foreground transition-colors duration-150 hover:text-foreground hover:underline"
                  >
                    {entry.voucher}
                  </Link>
                )}
              </div>
              {entry.balanced === false && (
                <p className="text-sm text-destructive" role="alert">
                  {t('journal_preview_unbalanced', { amount: formatRunAmount(entry.difference ?? 0) })}
                </p>
              )}
              <div className="overflow-x-auto">
                <VoucherLinesTable
                  withCurrency
                  lines={voucherLineViews(entry.lines)}
                />
              </div>
            </div>
          ))}
          {benefitValues !== undefined && benefitValues > 0 && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              {t('journal_preview_benefits_note', { amount: formatRunAmount(benefitValues) })}
              <HelpPopover>{t('journal_preview_benefits_help')}</HelpPopover>
            </p>
          )}
        </div>
      )}
    </DetailSection>
  )
}
