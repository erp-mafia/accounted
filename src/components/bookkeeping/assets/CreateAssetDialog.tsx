'use client'

import { useState } from 'react'
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
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronRightIcon } from '@/components/icons'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { HelpPopover } from '@/components/ui/help-popover'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { formatCurrency } from '@/lib/utils'
import type { AssetCategory, K3Component } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { validateOpeningDepreciation } from '@/lib/bokslut/assets/opening-depreciation'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  AssetComponentsEditor,
  componentDraftsTotal,
  newComponentDraft,
  parseComponentDrafts,
  type ComponentDraft,
} from './AssetComponentsEditor'
import {
  AssetIdentificationFields,
  identificationFrom,
  identificationPayload,
  saveAssetIdentification,
  useAssetIdentification,
} from './AssetIdentificationFields'

interface CreateAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

// Defaults are K2-redovisning (BFNAR 2016:10) schablon, NOT skattemässig
// avskrivning. Building / markanläggning values are conservative: IL 19/20
// kap may allow longer (50 yr) or shorter (10 yr) depending on byggnadstyp.
// Mark (land) is never depreciated: no years, its label from the messages.
const CATEGORY_OPTIONS: { value: AssetCategory; label: string; defaultYears: number }[] = [
  { value: 'computer', label: 'Dator / IT-utrustning', defaultYears: 3 },
  { value: 'equipment', label: 'Inventarier', defaultYears: 5 },
  { value: 'machinery', label: 'Maskiner', defaultYears: 10 },
  { value: 'vehicle', label: 'Fordon', defaultYears: 5 },
  { value: 'building', label: 'Byggnad', defaultYears: 25 },
  { value: 'land', label: '', defaultYears: 0 },
  { value: 'land_improvement', label: 'Markanläggning', defaultYears: 10 },
  { value: 'immaterial', label: 'Immateriell tillgång', defaultYears: 5 },
  { value: 'other_tangible', label: 'Övrig materiell tillgång', defaultYears: 5 },
]

// No account override here on purpose. The server resolves the immaterial
// default per framework (defaultAccountsForCategory in
// lib/bokslut/assets/asset-service.ts): 1090/1099 for K2, 1010/1019 for K3.
// Sending an explicit pair from this dialog would duplicate that rule on a
// second surface, and the edit dialog (which has no account inputs at all)
// could never mirror it. The hint below just tells the user where it lands.

export function CreateAssetDialog({ open, onOpenChange, onCreated }: CreateAssetDialogProps) {
  const t = useTranslations('assets')
  const { toast } = useToast()
  // useCompanyOptional so the dialog still works in tests / storyboards
  // that don't wrap it in CompanyProvider. K3 features simply hide.
  const companyCtx = useCompanyOptional()
  const isK3 = companyCtx?.company?.accounting_framework === 'k3'

  const [name, setName] = useState('')
  const [category, setCategory] = useState<AssetCategory>('equipment')
  const [acquisitionDate, setAcquisitionDate] = useState(
    todayIsoStockholm(),
  )
  const [acquisitionCost, setAcquisitionCost] = useState('')
  const [usefulLifeYears, setUsefulLifeYears] = useState('5')
  // K3 17.18: when the asset can be used, if later than the acquisition.
  const [startDate, setStartDate] = useState('')
  // K3 aktiveringsmodell: the company's own development (1010/1019).
  const [internallyGenerated, setInternallyGenerated] = useState(false)
  // Opening accumulated depreciation for an asset that arrives partly
  // depreciated from a previous system. Registered only, never posted. With
  // K3 components the server splits it over components that state none.
  const [openingAmount, setOpeningAmount] = useState('')
  const [openingDate, setOpeningDate] = useState('')
  // The opening block concerns a move from another register only, so it
  // waits behind a disclosure; a value in either field keeps it open, so
  // nothing entered is ever hidden.
  const [openingExpanded, setOpeningExpanded] = useState(false)
  const openingOpen = openingExpanded || openingAmount !== '' || openingDate !== ''
  // K3 component depreciation (17.4): the section is opt-in.
  const [useComponents, setUseComponents] = useState(false)
  const [componentDrafts, setComponentDrafts] = useState<ComponentDraft[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Building and vehicle identification (Bolaget rollout only).
  const tIdentification = useTranslations('bolaget_commitments.asset')
  const identification = useAssetIdentification(category)
  const [identificationValue, setIdentificationValue] = useState(identificationFrom())

  const handleCategoryChange = (next: AssetCategory) => {
    setCategory(next)
    const option = CATEGORY_OPTIONS.find((o) => o.value === next)
    if (option) setUsefulLifeYears(option.defaultYears.toString())
  }
  const isLand = category === 'land'
  const optionLabel = (option: { value: AssetCategory; label: string }) =>
    option.value === 'land' ? t('category_land') : option.label

  const parsedAcquisitionCost = parseFloat(acquisitionCost)
  const parsedOpeningAmount = openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
  const remainingAfterOpening =
    Number.isFinite(parsedAcquisitionCost) &&
    Number.isFinite(parsedOpeningAmount) &&
    parsedOpeningAmount > 0
      ? roundOre(parsedAcquisitionCost - parsedOpeningAmount)
      : null

  const toggleUseComponents = (next: boolean) => {
    setUseComponents(next)
    if (next && componentDrafts.length === 0) {
      setComponentDrafts([newComponentDraft()])
    }
  }

  const handleSubmit = async () => {
    setError(null)
    const cost = parseFloat(acquisitionCost)
    // Mark has no useful life: 0 months, never depreciated.
    const years = isLand ? 0 : parseInt(usefulLifeYears, 10)
    if (!name.trim() || !Number.isFinite(cost) || cost <= 0 || !Number.isFinite(years) || (!isLand && years <= 0)) {
      setError('Fyll i namn, anskaffningsvärde och avskrivningstid.')
      return
    }
    // K3 components: only when both the framework permits (gate at API)
    // and the user opted into the section.
    let componentsPayload: K3Component[] | null = null
    if (useComponents && isK3 && !isLand) {
      if (componentDrafts.length === 0) {
        setError(t('components.error_none'))
        return
      }
      const parsed = parseComponentDrafts(componentDrafts, t)
      if (parsed.error !== null) {
        setError(parsed.error)
        return
      }
      if (Math.abs(componentDraftsTotal(componentDrafts) - roundOre(cost)) > 0.005) {
        setError(t('components.mismatch', { amount: formatCurrency(cost) }))
        return
      }
      componentsPayload = parsed.components
    }

    const opening = isLand || openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
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

    const identificationChanges = identification.available
      ? identificationPayload(category, identificationValue, identificationFrom())
      : null
    if (identificationChanges === 'invalid') {
      setError(tIdentification('taxeringsvarde_invalid'))
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
          ...(!isLand && startDate ? { depreciation_start_date: startDate } : {}),
          ...(category === 'immaterial' && isK3 && internallyGenerated ? { internally_generated: true } : {}),
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
        setError(getUserErrorMessage(body?.error) ?? 'Kunde inte spara tillgången')
        return
      }
      if (identificationChanges && body?.data?.id) {
        const saved = await saveAssetIdentification(body.data.id, identificationChanges)
        if (!saved.ok) {
          toast({
            title: tIdentification('save_failed'),
            description: getUserErrorMessage(saved.body),
            variant: 'destructive',
          })
        }
      }
      toast({ title: 'Tillgång sparad', description: name.trim() })
      setIdentificationValue(identificationFrom())
      // Reset form for next entry
      setName('')
      setAcquisitionCost('')
      setOpeningAmount('')
      setOpeningDate('')
      setStartDate('')
      setInternallyGenerated(false)
      setOpeningExpanded(false)
      setUseComponents(false)
      setComponentDrafts([])
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isK3 ? 'sm:max-w-2xl' : 'sm:max-w-md'}>
        <DialogHeader>
          <DialogTitle>Ny anläggningstillgång</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="asset-name">Namn</Label>
            <Input
              id="asset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="t.ex. MacBook Pro 14"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-category">Kategori</Label>
            <Select value={category} onValueChange={(v) => handleCategoryChange(v as AssetCategory)}>
              <SelectTrigger id="asset-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {optionLabel(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {category === 'immaterial' && !isK3 && (
              <p className="text-xs text-muted-foreground">
                Bokförs som förvärvad immateriell tillgång (konto 1090). Egenupparbetad
                utveckling får inte aktiveras enligt K2 (BFNAR 2016:10 punkt 10.4): det kräver K3.
              </p>
            )}
            {category === 'immaterial' && isK3 && (
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={internallyGenerated}
                  onCheckedChange={(checked) => setInternallyGenerated(checked === true)}
                  className="mt-0.5"
                />
                <span>{t('own_development')}</span>
              </label>
            )}
          </div>
          <AssetIdentificationFields
            category={category}
            value={identificationValue}
            onChange={setIdentificationValue}
            available={identification.available}
            benefits={identification.benefits}
            idPrefix="asset"
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="asset-date">Anskaffat</Label>
              <Input
                id="asset-date"
                type="date"
                value={acquisitionDate}
                onChange={(e) => setAcquisitionDate(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="asset-cost">Anskaffningsvärde (kr)</Label>
                <HelpPopover>{t('register_help')}</HelpPopover>
              </div>
              <Input
                id="asset-cost"
                type="number"
                step="1"
                min="0"
                value={acquisitionCost}
                onChange={(e) => setAcquisitionCost(e.target.value)}
                placeholder="t.ex. 25000"
                className="tabular-nums"
              />
            </div>
          </div>
          {isLand ? (
            <p className="text-xs text-muted-foreground">{t('land_hint')}</p>
          ) : (
          <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="asset-life">Avskrivningstid (år)</Label>
              <HelpPopover>{t('life_help')}</HelpPopover>
            </div>
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
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="asset-start">{t('start.label')}</Label>
              <HelpPopover>{t('start.help')}</HelpPopover>
            </div>
            <Input
              id="asset-start"
              type="date"
              min={acquisitionDate}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="tabular-nums"
            />
          </div>
          </div>
          )}
          {isLand ? null : !openingOpen ? (
            <button
              type="button"
              onClick={() => setOpeningExpanded(true)}
              aria-expanded={false}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              <ChevronRightIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {t('opening.disclosure')}
            </button>
          ) : (
            <div className="space-y-3 rounded-lg p-4 bg-control shadow-raised">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">{t('opening.title')}</p>
                <HelpPopover>{t('opening.hint')}</HelpPopover>
              </div>
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
            </div>
          )}
          {isK3 && !isLand && (
            <div className="space-y-3 rounded-lg p-4 bg-control shadow-raised">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-muted-foreground">
                    {t('components.title')}
                  </Label>
                  <p className="text-xs text-muted-foreground">{t('components.hint')}</p>
                </div>
                <Button
                  type="button"
                  variant={useComponents ? 'default' : 'outline'}
                  onClick={() => toggleUseComponents(!useComponents)}
                >
                  {useComponents ? t('components.on') : t('components.off')}
                </Button>
              </div>

              {useComponents && (
                <AssetComponentsEditor
                  drafts={componentDrafts}
                  onChange={setComponentDrafts}
                  targetCost={Number.isFinite(parsedAcquisitionCost) ? parsedAcquisitionCost : null}
                />
              )}
            </div>
          )}
          {error && (
            <div className="bg-destructive/8 rounded-lg p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Avbryt
          </Button>
          <Button onClick={handleSubmit} loading={submitting}>
            {submitting ? (
              'Sparar…'
            ) : (
              'Spara'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
