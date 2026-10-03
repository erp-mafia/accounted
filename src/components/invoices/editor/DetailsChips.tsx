'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatChipDate, type DetailsChip } from '@/lib/invoices/editor/details'

const CHIP_CLASS =
  'inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-background px-3 text-[12.5px] tabular-nums transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 pointer-coarse:min-h-10'

const ADD_CHIP_CLASS = cn(CHIP_CLASS, 'border-dashed bg-transparent text-muted-foreground')

interface DetailsChipsProps {
  chips: DetailsChip[]
  /** Offertdatum on a quote, Fakturadatum otherwise. */
  isQuote: boolean
  /** yyyy-MM-dd: a date in another year shows its year. */
  today: string
  /** A chip opens the Detaljer fields at that field. */
  onSelect: (kind: DetailsChip['kind']) => void
}

/**
 * The folded Detaljer section: the invoice's dates, currency and language
 * as one row of pills. Each pill opens the fields at its own field, and the
 * dashed one adds what is not set yet (Dimensioner).
 */
export function DetailsChips({ chips, isQuote, today, onSelect }: DetailsChipsProps) {
  const t = useTranslations('invoice_editor_form')
  const locale = useLocale()
  const date = (iso: string) => formatChipDate(iso, locale, today)

  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((chip) => {
        let label: string
        let add = false
        switch (chip.kind) {
          case 'invoice_date':
            label = t(isQuote ? 'chip_quote_date' : 'chip_invoice_date', { date: date(chip.date) })
            break
          case 'due':
            label =
              chip.days !== null && chip.days >= 0
                ? t('chip_due_days', { date: date(chip.date), days: chip.days })
                : t('chip_due', { date: date(chip.date) })
            break
          case 'valid_until':
            label =
              chip.days !== null && chip.days >= 0
                ? t('chip_valid_until_days', { date: date(chip.date), days: chip.days })
                : t('chip_valid_until', { date: date(chip.date) })
            break
          case 'currency':
            label = chip.currency
            break
          case 'language':
            label = chip.language === 'en' ? t('language_en') : t('language_sv')
            break
          case 'dimensions':
            add = chip.dims === null
            label = chip.dims ? t('chip_dimensions', { dims: chip.dims }) : t('chip_add_dimensions')
            break
        }
        return (
          <button
            key={chip.kind}
            type="button"
            className={add ? ADD_CHIP_CLASS : CHIP_CLASS}
            onClick={() => onSelect(chip.kind)}
          >
            {add && <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            {label}
          </button>
        )
      })}
    </div>
  )
}
