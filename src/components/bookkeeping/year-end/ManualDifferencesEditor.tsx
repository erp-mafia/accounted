'use client'

import { useTranslations } from 'next-intl'
import { PlusIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { HelpPopover } from '@/components/ui/help-popover'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { parseAmountInput, roundOre } from '@/lib/money'
import type { ManualDifference } from '@/lib/bokslut/tax-provision/deferred-tax-service'

export interface ManualDraft {
  key: number
  label: string
  nature: 'asset' | 'liability'
  carrying: string
  tax: string
}

let draftKey = 0
export function manualDraft(item?: ManualDifference): ManualDraft {
  draftKey += 1
  return {
    key: draftKey,
    label: item?.label ?? '',
    nature: item?.nature ?? 'asset',
    carrying: item ? String(item.carrying_amount) : '',
    tax: item ? String(item.tax_value) : '',
  }
}

/** The drafts as temporary differences, or null when one lacks a name or an amount. */
export function manualDifferencesOf(rows: readonly ManualDraft[]): ManualDifference[] | null {
  const items: ManualDifference[] = []
  for (const row of rows) {
    const carrying = parseAmountInput(row.carrying)
    const tax = parseAmountInput(row.tax)
    if (!row.label.trim() || carrying === null || tax === null) return null
    items.push({ label: row.label.trim(), nature: row.nature, carrying_amount: roundOre(carrying), tax_value: roundOre(tax) })
  }
  return items
}

/**
 * Temporary differences entered by hand (K3 29.14): an item whose carrying
 * amount and tax value differ that the register does not compute. Used by
 * the year's deferred tax and by the opening deferred tax at the transition
 * to K3.
 */
export function ManualDifferencesEditor({
  rows,
  onChange,
  idPrefix,
}: {
  rows: ManualDraft[]
  onChange: (rows: ManualDraft[]) => void
  idPrefix: string
}) {
  const t = useTranslations('deferred_tax')
  const update = (key: number, patch: Partial<ManualDraft>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{t('manual_title')}</p>
        <HelpPopover>{t('manual_help')}</HelpPopover>
      </div>
      {rows.map((row) => (
        <div key={row.key} className="grid grid-cols-12 items-end gap-2">
          <div className="col-span-12 space-y-1 sm:col-span-4">
            <Label htmlFor={`${idPrefix}-label-${row.key}`} className="text-xs text-muted-foreground">{t('manual_label')}</Label>
            <Input id={`${idPrefix}-label-${row.key}`} value={row.label} onChange={(e) => update(row.key, { label: e.target.value })} />
          </div>
          <div className="col-span-4 space-y-1 sm:col-span-2">
            <Label htmlFor={`${idPrefix}-nature-${row.key}`} className="text-xs text-muted-foreground">{t('manual_nature')}</Label>
            <Select value={row.nature} onValueChange={(value) => update(row.key, { nature: value as ManualDraft['nature'] })}>
              <SelectTrigger id={`${idPrefix}-nature-${row.key}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asset">{t('nature_asset')}</SelectItem>
                <SelectItem value="liability">{t('nature_liability')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-4 space-y-1 sm:col-span-3">
            <Label htmlFor={`${idPrefix}-carrying-${row.key}`} className="text-xs text-muted-foreground">{t('manual_carrying')}</Label>
            <Input
              id={`${idPrefix}-carrying-${row.key}`}
              type="number"
              step="0.01"
              value={row.carrying}
              onChange={(e) => update(row.key, { carrying: e.target.value })}
              className="tabular-nums"
            />
          </div>
          <div className="col-span-3 space-y-1 sm:col-span-2">
            <Label htmlFor={`${idPrefix}-tax-${row.key}`} className="text-xs text-muted-foreground">{t('manual_tax')}</Label>
            <Input
              id={`${idPrefix}-tax-${row.key}`}
              type="number"
              step="0.01"
              value={row.tax}
              onChange={(e) => update(row.key, { tax: e.target.value })}
              className="tabular-nums"
            />
          </div>
          <div className="col-span-1 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
              aria-label={t('manual_remove', { label: row.label || '' })}
            >
              <XMarkIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, manualDraft()])}>
        <PlusIcon className="mr-1 h-4 w-4" /> {t('manual_add')}
      </Button>
    </div>
  )
}
