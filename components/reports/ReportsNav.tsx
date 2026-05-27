'use client'

import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { EntityType } from '@/types'

interface ReportItem {
  value: string
  labelKey: string
  entityType?: EntityType
}

interface ReportCategory {
  labelKey: string
  items: ReportItem[]
}

const CATEGORIES: ReportCategory[] = [
  {
    labelKey: 'group_interim',
    items: [
      { value: 'resultatrapport', labelKey: 'name_resultatrapport' },
      { value: 'balansrapport', labelKey: 'name_balansrapport' },
      { value: 'trial-balance', labelKey: 'name_trial_balance' },
    ],
  },
  {
    labelKey: 'group_year_end',
    items: [
      { value: 'income-statement', labelKey: 'name_income_statement' },
      { value: 'balance-sheet', labelKey: 'name_balance_sheet' },
      { value: 'kassaflodesanalys', labelKey: 'name_kassaflodesanalys' },
      { value: 'arsredovisning', labelKey: 'name_arsredovisning', entityType: 'aktiebolag' },
    ],
  },
  {
    labelKey: 'group_tax_vat',
    items: [
      { value: 'vat-declaration', labelKey: 'name_vat_declaration' },
      { value: 'periodisk-sammanstallning', labelKey: 'name_periodisk_sammanstallning' },
      { value: 'ne-declaration', labelKey: 'name_ne_declaration', entityType: 'enskild_firma' },
      { value: 'ink2-declaration', labelKey: 'name_ink2_declaration', entityType: 'aktiebolag' },
    ],
  },
  {
    labelKey: 'group_ledgers',
    items: [
      { value: 'huvudbok', labelKey: 'name_huvudbok' },
      { value: 'grundbok', labelKey: 'name_grundbok' },
      { value: 'kundreskontra', labelKey: 'name_kundreskontra' },
      { value: 'supplier-ledger', labelKey: 'name_supplier_ledger' },
    ],
  },
  {
    labelKey: 'group_reconciliation',
    items: [
      { value: 'bank-reconciliation', labelKey: 'name_bank_reconciliation' },
    ],
  },
]

interface ReportsNavProps {
  active: string
  onChange: (value: string) => void
  entityType?: EntityType
}

export function ReportsNav({ active, onChange, entityType }: ReportsNavProps) {
  const t = useTranslations('reports')
  const filtered = CATEGORIES
    .map(cat => ({
      ...cat,
      items: cat.items.filter(item => !item.entityType || item.entityType === entityType),
    }))
    .filter(cat => cat.items.length > 0)

  return (
    <>
      {/* Mobile: grouped select */}
      <div className="sm:hidden">
        <Select value={active} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {filtered.map(cat => (
              <SelectGroup key={cat.labelKey}>
                <SelectLabel>{t(cat.labelKey)}</SelectLabel>
                {cat.items.map(item => (
                  <SelectItem key={item.value} value={item.value}>
                    {t(item.labelKey)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: vertical left rail */}
      <nav
        className="hidden sm:block w-56 flex-shrink-0 sticky top-8 self-start"
        aria-label={t('categories_aria')}
      >
        <ul className="space-y-6">
          {filtered.map(cat => (
            <li key={cat.labelKey}>
              <p className="text-[11px] font-semibold text-muted-foreground/80 uppercase tracking-[0.08em] mb-2 px-3">
                {t(cat.labelKey)}
              </p>
              <ul className="space-y-px">
                {cat.items.map(item => {
                  const isActive = active === item.value
                  return (
                    <li key={item.value}>
                      <button
                        type="button"
                        onClick={() => onChange(item.value)}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'w-full text-left px-3 py-1.5 rounded-md text-[13px] transition-colors',
                          isActive
                            ? 'bg-primary/10 text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
                        )}
                      >
                        {t(item.labelKey)}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
