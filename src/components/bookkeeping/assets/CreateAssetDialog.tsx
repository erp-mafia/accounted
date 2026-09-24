'use client'

import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { formatCurrency } from '@/lib/utils'
import type { AssetCategory, K3Component } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { validateOpeningDepreciation } from '@/lib/bokslut/assets/opening-depreciation'

interface CreateAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

/** Editor row state: strings so the user can clear inputs without zeroing
 *  out the component immediately. Converted to numbers at submit time. */
interface ComponentRow {
  id: string
  name: string
  cost: string
  useful_life_months: string
  salvage_value: string
}

let componentRowCounter = 0
function newComponentRow(): ComponentRow {
  componentRowCounter += 1
  return {
    id: `cmp-${componentRowCounter}`,
    name: '',
    cost: '',
    useful_life_months: '',
    salvage_value: '',
  }
}

// Defaults are K2-redovisning (BFNAR 2016:10) schablon, NOT skattemässig
// avskrivning. Building / markanläggning values are conservative: IL 19/20
// kap may allow longer (50 yr) or shorter (10 yr) depending on byggnadstyp.
const CATEGORY_OPTIONS: { value: AssetCategory; defaultYears: number }[] = [
  { value: 'computer', defaultYears: 3 },
  { value: 'equipment', defaultYears: 5 },
  { value: 'machinery', defaultYears: 10 },
  { value: 'vehicle', defaultYears: 5 },
  { value: 'building', defaultYears: 25 },
  { value: 'land_improvement', defaultYears: 10 },
  { value: 'immaterial', defaultYears: 5 },
  { value: 'other_tangible', defaultYears: 5 },
]

// No account override here on purpose. The server resolves the immaterial
// default per framework (defaultAccountsForCategory in
// lib/bokslut/assets/asset-service.ts): 1090/1099 for K2, 1010/1019 for K3.
// Sending an explicit pair from this dialog would duplicate that rule on a
// second surface, and the edit dialog (which has no account inputs at all)
// could never mirror it. The hint below just tells the user where it lands.

export function CreateAssetDialog({ open, onOpenChange, onCreated }: CreateAssetDialogProps) {
  const t = useTranslations('assets')
  const tc = useTranslations('common')
  const { toast } = useToast()
  const categoryLabels: Record<AssetCategory, string> = {
    computer: t('dialog.category_computer'),
    equipment: t('dialog.category_equipment'),
    machinery: t('dialog.category_machinery'),
    vehicle: t('dialog.category_vehicle'),
    building: t('dialog.category_building'),
    land_improvement: t('dialog.category_land_improvement'),
    immaterial: t('dialog.category_immaterial'),
    other_tangible: t('dialog.category_other_tangible'),
  }
  // useCompanyOptional so the dialog still works in tests / storyboards
  // that don't wrap it in CompanyProvider. K3 features simply hide.
  const companyCtx = useCompanyOptional()
  const isK3 = companyCtx?.company?.accounting_framework === 'k3'

  const [name, setName] = useState('')
  const [category, setCategory] = useState<AssetCategory>('equipment')
  const [acquisitionDate, setAcquisitionDate] = useState(
    new Date().toISOString().split('T')[0],
  )
  const [acquisitionCost, setAcquisitionCost] = useState('')
  const [usefulLifeYears, setUsefulLifeYears] = useState('5')
  // Opening accumulated depreciation for an asset that arrives partly
  // depreciated from a previous system. Registered only, never posted.
  const [openingAmount, setOpeningAmount] = useState('')
  const [openingDate, setOpeningDate] = useState('')
  // K3 component depreciation. `useComponents` toggles the advanced section;
  // null when disabled, an array (possibly empty during editing) when enabled.
  const [useComponents, setUseComponents] = useState(false)
  const [componentRows, setComponentRows] = useState<ComponentRow[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCategoryChange = (next: AssetCategory) => {
    setCategory(next)
    const option = CATEGORY_OPTIONS.find((o) => o.value === next)
    if (option) setUsefulLifeYears(option.defaultYears.toString())
  }

  const totalComponentCost = useMemo(() => {
    return componentRows.reduce((sum, row) => {
      const v = parseFloat(row.cost)
      return Number.isFinite(v) ? sum + v : sum
    }, 0)
  }, [componentRows])

  const parsedAcquisitionCost = parseFloat(acquisitionCost)
  const parsedOpeningAmount = openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
  const remainingAfterOpening =
    Number.isFinite(parsedAcquisitionCost) &&
    Number.isFinite(parsedOpeningAmount) &&
    parsedOpeningAmount > 0
      ? roundOre(parsedAcquisitionCost - parsedOpeningAmount)
      : null
  const componentMismatch =
    useComponents
    && componentRows.length > 0
    && Number.isFinite(parsedAcquisitionCost)
    && Math.abs(totalComponentCost - parsedAcquisitionCost) > 1

  const addComponentRow = () => {
    setComponentRows((rows) => [...rows, newComponentRow()])
  }
  const removeComponentRow = (id: string) => {
    setComponentRows((rows) => rows.filter((r) => r.id !== id))
  }
  const updateComponentRow = (id: string, patch: Partial<ComponentRow>) => {
    setComponentRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }
  const toggleUseComponents = (next: boolean) => {
    setUseComponents(next)
    if (next && componentRows.length === 0) {
      setComponentRows([newComponentRow()])
    }
  }

  const handleSubmit = async () => {
    setError(null)
    const cost = parseFloat(acquisitionCost)
    const years = parseInt(usefulLifeYears, 10)
    if (!name.trim() || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(years) || years <= 0) {
      setError(t('dialog.error_required_fields'))
      return
    }
    // K3 components: only when both the framework permits (gate at API)
    // and the user opted into the section. Empty array is invalid (the
    // validator rejects it) so the dialog also flips back to "off" when
    // every row is removed.
    let componentsPayload: K3Component[] | null = null
    if (useComponents && isK3) {
      if (componentRows.length === 0) {
        setError(t('dialog.error_no_components'))
        return
      }
      const parsed: K3Component[] = []
      for (const [index, row] of componentRows.entries()) {
        const componentCost = parseFloat(row.cost)
        const months = parseInt(row.useful_life_months, 10)
        const salvageRaw = row.salvage_value.trim()
        const salvage = salvageRaw === '' ? undefined : parseFloat(salvageRaw)
        const trimmedName = row.name.trim()
        if (!trimmedName) {
          setError(t('dialog.error_component_name', { index: index + 1 }))
          return
        }
        if (!Number.isFinite(componentCost) || componentCost <= 0) {
          setError(t('dialog.error_component_cost', { name: trimmedName }))
          return
        }
        if (!Number.isFinite(months) || months <= 0) {
          setError(t('dialog.error_component_months', { name: trimmedName }))
          return
        }
        if (salvage !== undefined && (!Number.isFinite(salvage) || salvage < 0)) {
          setError(t('dialog.error_component_salvage_negative', { name: trimmedName }))
          return
        }
        if (salvage !== undefined && salvage > componentCost) {
          setError(t('dialog.error_component_salvage_exceeds', { name: trimmedName }))
          return
        }
        parsed.push({
          name: trimmedName,
          cost: componentCost,
          useful_life_months: months,
          ...(salvage !== undefined ? { salvage_value: salvage } : {}),
        })
      }
      const sum = parsed.reduce((s, c) => s + c.cost, 0)
      if (Math.abs(sum - cost) > 1) {
        setError(
          t('dialog.error_component_sum', {
            sum: formatCurrency(sum),
            cost: formatCurrency(cost),
          }),
        )
        return
      }
      componentsPayload = parsed
    }

    const opening = openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
    const openingIssues = validateOpeningDepreciation({
      acquisition_cost: cost,
      acquisition_date: acquisitionDate,
      opening_accumulated_depreciation: Number.isFinite(opening) ? opening : -1,
      opening_depreciation_date: openingDate || null,
      k3_components: componentsPayload,
    })
    if (openingIssues.length > 0) {
      setError(t(`opening.error_${openingIssues[0].kind}`))
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          category,
          acquisition_date: acquisitionDate,
          acquisition_cost: cost,
          useful_life_months: years * 12,
          ...(componentsPayload !== null ? { k3_components: componentsPayload } : {}),
          ...(opening > 0
            ? {
                opening_accumulated_depreciation: roundOre(opening),
                opening_depreciation_date: openingDate,
              }
            : {}),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getUserErrorMessage(body?.error) ?? t('dialog.save_failed'))
        return
      }
      toast({ title: t('dialog.created_toast'), description: name.trim() })
      // Reset form for next entry
      setName('')
      setAcquisitionCost('')
      setOpeningAmount('')
      setOpeningDate('')
      setUseComponents(false)
      setComponentRows([])
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : t('dialog.unknown_error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isK3 ? 'sm:max-w-2xl' : 'sm:max-w-md'}>
        <DialogHeader>
          <DialogTitle>{t('dialog.create_title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="asset-name">{t('th_name')}</Label>
            <Input
              id="asset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('dialog.name_placeholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-category">{t('th_category')}</Label>
            <Select value={category} onValueChange={(v) => handleCategoryChange(v as AssetCategory)}>
              <SelectTrigger id="asset-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {categoryLabels[o.value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {category === 'immaterial' && !isK3 && (
              <p className="text-xs text-muted-foreground">
                {t('dialog.immaterial_hint_k2')}
              </p>
            )}
            {category === 'immaterial' && isK3 && (
              <p className="text-xs text-muted-foreground">
                {t('dialog.immaterial_hint_k3')}
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="asset-date">{t('th_acquired')}</Label>
              <Input
                id="asset-date"
                type="date"
                value={acquisitionDate}
                onChange={(e) => setAcquisitionDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="asset-cost">{t('dialog.acquisition_cost_label')}</Label>
              <Input
                id="asset-cost"
                type="number"
                step="1"
                min="0"
                value={acquisitionCost}
                onChange={(e) => setAcquisitionCost(e.target.value)}
                placeholder={t('dialog.cost_placeholder')}
                className="tabular-nums"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-life">{t('dialog.useful_life_label')}</Label>
            <Input
              id="asset-life"
              type="number"
              min="1"
              max="50"
              step="1"
              value={usefulLifeYears}
              onChange={(e) => setUsefulLifeYears(e.target.value)}
              className="tabular-nums"
            />
            <p className="text-xs text-muted-foreground">
              {t('dialog.useful_life_hint')}
            </p>
          </div>
          <div className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-sm font-medium">{t('opening.title')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="asset-opening-amount">{t('opening.amount_label')}</Label>
                <Input
                  id="asset-opening-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={openingAmount}
                  onChange={(e) => setOpeningAmount(e.target.value)}
                  placeholder="0"
                  className="tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="asset-opening-date">{t('opening.date_label')}</Label>
                <Input
                  id="asset-opening-date"
                  type="date"
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                  className="tabular-nums"
                />
              </div>
            </div>
            {remainingAfterOpening !== null && (
              <p className="text-xs tabular-nums text-foreground">
                {t('opening.remaining', { amount: formatCurrency(remainingAfterOpening) })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t('opening.hint')}</p>
          </div>
          {isK3 && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    {t('dialog.components_title')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('dialog.components_hint')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant={useComponents ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleUseComponents(!useComponents)}
                >
                  {useComponents ? t('dialog.components_enabled') : t('dialog.components_enable')}
                </Button>
              </div>

              {useComponents && (
                <div className="space-y-2">
                  {componentRows.map((row, idx) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-12 items-end gap-2 rounded-lg border border-border bg-background p-2"
                    >
                      <div className="col-span-12 sm:col-span-4 space-y-1">
                        <Label
                          htmlFor={`cmp-name-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {t('dialog.component_label')}
                        </Label>
                        <Input
                          id={`cmp-name-${row.id}`}
                          value={row.name}
                          onChange={(e) =>
                            updateComponentRow(row.id, { name: e.target.value })
                          }
                          placeholder={idx === 0 ? t('dialog.component_placeholder_first') : t('th_name')}
                        />
                      </div>
                      <div className="col-span-6 sm:col-span-3 space-y-1">
                        <Label
                          htmlFor={`cmp-cost-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {t('dialog.component_cost_label')}
                        </Label>
                        <Input
                          id={`cmp-cost-${row.id}`}
                          type="number"
                          min="0"
                          step="1"
                          value={row.cost}
                          onChange={(e) =>
                            updateComponentRow(row.id, { cost: e.target.value })
                          }
                          className="tabular-nums"
                        />
                      </div>
                      <div className="col-span-6 sm:col-span-2 space-y-1">
                        <Label
                          htmlFor={`cmp-life-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {t('dialog.component_life_label')}
                        </Label>
                        <Input
                          id={`cmp-life-${row.id}`}
                          type="number"
                          min="1"
                          step="1"
                          value={row.useful_life_months}
                          onChange={(e) =>
                            updateComponentRow(row.id, { useful_life_months: e.target.value })
                          }
                          className="tabular-nums"
                        />
                      </div>
                      <div className="col-span-9 sm:col-span-2 space-y-1">
                        <Label
                          htmlFor={`cmp-salvage-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {t('dialog.component_salvage_label')}
                        </Label>
                        <Input
                          id={`cmp-salvage-${row.id}`}
                          type="number"
                          min="0"
                          step="1"
                          value={row.salvage_value}
                          onChange={(e) =>
                            updateComponentRow(row.id, { salvage_value: e.target.value })
                          }
                          placeholder="0"
                          className="tabular-nums"
                        />
                      </div>
                      <div className="col-span-3 sm:col-span-1 flex justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => removeComponentRow(row.id)}
                          aria-label={t('dialog.remove_component')}
                          disabled={componentRows.length === 1}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}

                  <div className="flex items-center justify-between gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addComponentRow}
                    >
                      <Plus className="mr-1 h-4 w-4" /> {t('dialog.add_component')}
                    </Button>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {t('dialog.components_sum_label')}{' '}
                      <span
                        className={
                          componentMismatch
                            ? 'text-destructive font-medium'
                            : 'text-foreground'
                        }
                      >
                        {formatCurrency(totalComponentCost)}
                      </span>
                    </div>
                  </div>

                  {componentMismatch && (
                    <p className="text-xs text-destructive">
                      {t('dialog.components_mismatch', {
                        cost: formatCurrency(parsedAcquisitionCost),
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            {t.rich('dialog.tip', {
              strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
            })}
          </div>
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {submitting ? (
              t('dialog.saving')
            ) : (
              tc('save')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
