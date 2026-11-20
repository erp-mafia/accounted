'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowPathRoundedSquareIcon, PlusIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatCurrency } from '@/lib/utils'
import { parseAmountInput, roundOre } from '@/lib/money'
import type { AssetComponent, K3Component } from '@/types'

/**
 * One component row while it is being edited (K3 17.4): strings, so a field
 * can be cleared without the row turning into zeros. `componentId` names a
 * component already in the register; `basisLocked` is set when the asset's
 * depreciation has posted, so cost, dates and opening are read-only (the
 * server refuses them too: storno first).
 */
export interface ComponentDraft {
  key: string
  componentId?: string
  name: string
  cost: string
  lifeMonths: string
  notDepreciated: boolean
  salvage: string
  startDate: string
  openingAmount: string
  openingDate: string
  basisLocked: boolean
}

let draftCounter = 0

export function newComponentDraft(): ComponentDraft {
  draftCounter += 1
  return {
    key: `component-draft-${draftCounter}`,
    name: '',
    cost: '',
    lifeMonths: '',
    notDepreciated: false,
    salvage: '',
    startDate: '',
    openingAmount: '',
    openingDate: '',
    basisLocked: false,
  }
}

/** The editable rows of the asset's active components. */
export function draftsFromComponents(components: readonly AssetComponent[], basisLocked: boolean): ComponentDraft[] {
  return [...components]
    .filter((component) => component.derecognised_at === null)
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at))
    .map((component) => {
      const opening = roundOre(Number(component.opening_accumulated_depreciation ?? 0) || 0)
      return {
        key: component.id,
        componentId: component.id,
        name: component.name,
        cost: String(roundOre(Number(component.cost))),
        lifeMonths: component.useful_life_months === null ? '' : String(component.useful_life_months),
        notDepreciated: component.useful_life_months === null,
        salvage: Number(component.salvage_value) > 0 ? String(roundOre(Number(component.salvage_value))) : '',
        startDate: component.depreciation_start_date ?? '',
        openingAmount: opening > 0 ? String(opening) : '',
        openingDate: component.opening_depreciation_date ?? '',
        basisLocked,
      }
    })
}

export type DraftParseResult = { components: K3Component[]; error: null } | { components: null; error: string }

/**
 * The drafts as the API takes them, or the first error in the active
 * locale. Empty optional fields are left out, so an existing component
 * keeps what the register holds for them.
 */
export function parseComponentDrafts(
  drafts: readonly ComponentDraft[],
  t: (key: string, values?: Record<string, string | number>) => string,
): DraftParseResult {
  const components: K3Component[] = []
  for (const [index, draft] of drafts.entries()) {
    const label = draft.name.trim() || t('components.row_label', { index: index + 1 })
    const cost = parseAmountInput(draft.cost) ?? Number.NaN
    if (!draft.name.trim()) return { components: null, error: t('components.error_name', { index: index + 1 }) }
    if (!Number.isFinite(cost) || cost <= 0) return { components: null, error: t('components.error_cost', { name: label }) }
    const months = Number(draft.lifeMonths)
    if (!draft.notDepreciated && (!Number.isInteger(months) || months <= 0)) {
      return { components: null, error: t('components.error_life', { name: label }) }
    }
    const salvage = draft.salvage.trim() === '' ? 0 : parseAmountInput(draft.salvage) ?? Number.NaN
    if (!Number.isFinite(salvage) || salvage < 0 || salvage > cost) {
      return { components: null, error: t('components.error_salvage', { name: label }) }
    }
    const opening = draft.openingAmount.trim() === '' ? 0 : parseAmountInput(draft.openingAmount) ?? Number.NaN
    if (!Number.isFinite(opening) || opening < 0 || (opening > 0 && !draft.openingDate)) {
      return { components: null, error: t('components.error_opening', { name: label }) }
    }
    components.push({
      ...(draft.componentId ? { component_id: draft.componentId } : {}),
      name: draft.name.trim(),
      cost: roundOre(cost),
      useful_life_months: draft.notDepreciated ? null : months,
      ...(salvage > 0 || draft.componentId ? { salvage_value: roundOre(salvage) } : {}),
      ...(draft.startDate ? { depreciation_start_date: draft.startDate } : draft.componentId ? { depreciation_start_date: null } : {}),
      ...(opening > 0
        ? { opening_accumulated_depreciation: roundOre(opening), opening_depreciation_date: draft.openingDate }
        : draft.componentId && !draft.basisLocked
          ? { opening_accumulated_depreciation: 0, opening_depreciation_date: null }
          : {}),
    })
  }
  return { components, error: null }
}

export function componentDraftsTotal(drafts: readonly ComponentDraft[]): number {
  return roundOre(
    drafts.reduce((sum, draft) => {
      const value = parseAmountInput(draft.cost) ?? Number.NaN
      return Number.isFinite(value) ? sum + value : sum
    }, 0),
  )
}

interface AssetComponentsEditorProps {
  drafts: ComponentDraft[]
  onChange: (drafts: ComponentDraft[]) => void
  /** The cost the components must cover (create); omitted when the cost follows them (edit). */
  targetCost?: number | null
  /** Offered on a registered component: opens the replacement (K3 17.5, 17.21A). */
  onReplace?: (componentId: string) => void
  disabled?: boolean
}

export function AssetComponentsEditor({ drafts, onChange, targetCost, onReplace, disabled }: AssetComponentsEditorProps) {
  const t = useTranslations('assets')
  const [details, setDetails] = useState(() => drafts.some((d) => d.startDate || d.openingAmount))
  const total = componentDraftsTotal(drafts)
  const mismatch = targetCost !== undefined && targetCost !== null && Math.abs(total - targetCost) > 0.005

  const update = (key: string, patch: Partial<ComponentDraft>) =>
    onChange(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)))
  const remove = (key: string) => onChange(drafts.filter((draft) => draft.key !== key))

  return (
    <div className="space-y-2">
      {drafts.map((draft, index) => (
        <div key={draft.key} className="grid grid-cols-12 items-end gap-2 rounded-lg p-2 bg-control shadow-raised">
          <div className="col-span-12 space-y-1 sm:col-span-4">
            <Label htmlFor={`cmp-name-${draft.key}`} className="text-xs text-muted-foreground">
              {t('components.name')}
            </Label>
            <Input
              id={`cmp-name-${draft.key}`}
              value={draft.name}
              onChange={(e) => update(draft.key, { name: e.target.value })}
              placeholder={index === 0 ? t('components.name_placeholder') : undefined}
              disabled={disabled}
            />
          </div>
          <div className="col-span-6 space-y-1 sm:col-span-3">
            <Label htmlFor={`cmp-cost-${draft.key}`} className="text-xs text-muted-foreground">
              {t('components.cost')}
            </Label>
            <Input
              id={`cmp-cost-${draft.key}`}
              type="number"
              min="0"
              step="0.01"
              value={draft.cost}
              onChange={(e) => update(draft.key, { cost: e.target.value })}
              disabled={disabled || draft.basisLocked}
              className="tabular-nums"
            />
          </div>
          <div className="col-span-6 space-y-1 sm:col-span-2">
            <Label htmlFor={`cmp-life-${draft.key}`} className="text-xs text-muted-foreground">
              {t('components.life_months')}
            </Label>
            <Input
              id={`cmp-life-${draft.key}`}
              type="number"
              min="1"
              step="1"
              value={draft.notDepreciated ? '' : draft.lifeMonths}
              onChange={(e) => update(draft.key, { lifeMonths: e.target.value })}
              disabled={disabled || draft.notDepreciated}
              className="tabular-nums"
            />
          </div>
          <div className="col-span-8 space-y-1 sm:col-span-2">
            <Label htmlFor={`cmp-salvage-${draft.key}`} className="text-xs text-muted-foreground">
              {t('components.salvage')}
            </Label>
            <Input
              id={`cmp-salvage-${draft.key}`}
              type="number"
              min="0"
              step="0.01"
              value={draft.salvage}
              onChange={(e) => update(draft.key, { salvage: e.target.value })}
              placeholder="0"
              disabled={disabled}
              className="tabular-nums"
            />
          </div>
          <div className="col-span-4 flex justify-end gap-1 sm:col-span-1">
            {onReplace && draft.componentId && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onReplace(draft.componentId!)}
                aria-label={t('components.replace', { name: draft.name })}
                disabled={disabled}
              >
                <ArrowPathRoundedSquareIcon className="h-4 w-4" />
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(draft.key)}
              aria-label={t('components.remove', { name: draft.name })}
              disabled={disabled || drafts.length === 1 || draft.basisLocked}
            >
              <XMarkIcon className="h-4 w-4" />
            </Button>
          </div>
          <label className="col-span-12 flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={draft.notDepreciated}
              onCheckedChange={(checked) => update(draft.key, { notDepreciated: checked === true })}
              disabled={disabled || draft.basisLocked}
            />
            {t('components.not_depreciated')}
          </label>
          {details && (
            <>
              <div className="col-span-12 space-y-1 sm:col-span-4">
                <Label htmlFor={`cmp-start-${draft.key}`} className="text-xs text-muted-foreground">
                  {t('components.start_date')}
                </Label>
                <Input
                  id={`cmp-start-${draft.key}`}
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => update(draft.key, { startDate: e.target.value })}
                  disabled={disabled || draft.basisLocked || draft.notDepreciated}
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-6 space-y-1 sm:col-span-4">
                <Label htmlFor={`cmp-opening-${draft.key}`} className="text-xs text-muted-foreground">
                  {t('components.opening_amount')}
                </Label>
                <Input
                  id={`cmp-opening-${draft.key}`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.openingAmount}
                  onChange={(e) => update(draft.key, { openingAmount: e.target.value })}
                  disabled={disabled || draft.basisLocked || draft.notDepreciated}
                  placeholder="0"
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-6 space-y-1 sm:col-span-4">
                <Label htmlFor={`cmp-opening-date-${draft.key}`} className="text-xs text-muted-foreground">
                  {t('components.opening_date')}
                </Label>
                <Input
                  id={`cmp-opening-date-${draft.key}`}
                  type="date"
                  value={draft.openingDate}
                  onChange={(e) => update(draft.key, { openingDate: e.target.value })}
                  disabled={disabled || draft.basisLocked || draft.notDepreciated}
                  className="tabular-nums"
                />
              </div>
            </>
          )}
        </div>
      ))}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={() => onChange([...drafts, newComponentDraft()])} disabled={disabled}>
            <PlusIcon className="h-4 w-4" /> {t('components.add')}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setDetails((value) => !value)}>
            {details ? t('components.details_hide') : t('components.details_show')}
          </Button>
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {t('components.total')}{' '}
          <span className={mismatch ? 'font-medium text-destructive' : 'text-foreground'}>{formatCurrency(total)}</span>
        </div>
      </div>
      {mismatch && targetCost !== undefined && targetCost !== null && (
        <p className="text-xs text-destructive">{t('components.mismatch', { amount: formatCurrency(targetCost) })}</p>
      )}
    </div>
  )
}
