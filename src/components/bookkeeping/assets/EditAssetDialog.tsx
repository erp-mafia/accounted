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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LockClosedIcon, TrashIcon } from '@/components/icons'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { validateOpeningDepreciation } from '@/lib/bokslut/assets/opening-depreciation'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { Asset, AssetCategory, AssetComponent } from '@/types'
import {
  AssetComponentsEditor,
  componentDraftsTotal,
  draftsFromComponents,
  newComponentDraft,
  parseComponentDrafts,
  type ComponentDraft,
} from './AssetComponentsEditor'
import { ReplaceComponentDialog } from './ReplaceComponentDialog'
import { ImpairAssetDialog } from './ImpairAssetDialog'
import { TaxPlanSection } from './TaxPlanSection'
import { HelpPopover } from '@/components/ui/help-popover'
import { netWrittenDown } from '@/lib/bokslut/assets/value-adjustments'
import {
  AssetIdentificationFields,
  identificationFrom,
  identificationPayload,
  saveAssetIdentification,
  useAssetIdentification,
} from './AssetIdentificationFields'

/** The list route annotates each asset with whether any depreciation has been
 *  posted against it. When true, the acquisition-basis fields are locked. */
type EditableAsset = Asset & { has_posted_depreciation?: boolean; deletable?: boolean }

interface EditAssetDialogProps {
  asset: EditableAsset
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
  /** Offered by the page only when the row never reached the books
   *  (deletable). The page owns the confirm and the DELETE call. */
  onDelete?: () => void
}

// Same category labels as CreateAssetDialog.
const CATEGORY_OPTIONS: { value: AssetCategory; label: string }[] = [
  { value: 'computer', label: 'Dator / IT-utrustning' },
  { value: 'equipment', label: 'Inventarier' },
  { value: 'machinery', label: 'Maskiner' },
  { value: 'vehicle', label: 'Fordon' },
  { value: 'building', label: 'Byggnad' },
  { value: 'land', label: '' },
  { value: 'land_improvement', label: 'Markanläggning' },
  { value: 'immaterial', label: 'Immateriell tillgång' },
  { value: 'other_tangible', label: 'Övrig materiell tillgång' },
]

export function EditAssetDialog({
  asset,
  open,
  onOpenChange,
  onSaved,
  onDelete,
}: EditAssetDialogProps) {
  const t = useTranslations('assets')
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const companyCtx = useCompanyOptional()
  const isK3 = companyCtx?.company?.accounting_framework === 'k3'
  // Once depreciation has been booked, acquisition date/cost/category are
  // locked: a real change has to go through storno. The server enforces the
  // same rule (ASSET_CORRECTION_BLOCKED); this just makes it visible up front.
  const basisLocked = asset.has_posted_depreciation === true

  // K3 components (17.4): an asset that has them is edited through them; its
  // cost, salvage value and opening are their sums.
  const registered = asset.components ?? []
  const hasComponents = registered.some((component) => component.derecognised_at === null)
  const replaced = registered.filter((component) => component.derecognised_at !== null)
  const [useComponents, setUseComponents] = useState(hasComponents)
  const [componentDrafts, setComponentDrafts] = useState<ComponentDraft[]>(() =>
    draftsFromComponents(registered, basisLocked),
  )
  const [componentsTouched, setComponentsTouched] = useState(false)
  const [replacing, setReplacing] = useState<AssetComponent | null>(null)

  const [name, setName] = useState(asset.name)
  const [category, setCategory] = useState<AssetCategory>(asset.category)
  const [acquisitionDate, setAcquisitionDate] = useState(asset.acquisition_date)
  const [acquisitionCost, setAcquisitionCost] = useState(String(asset.acquisition_cost))
  const [usefulLifeYears, setUsefulLifeYears] = useState(
    String(Math.round(asset.useful_life_months / 12)),
  )
  const storedOpeningAmount = roundOre(Number(asset.opening_accumulated_depreciation ?? 0) || 0)
  const storedOpeningDate = asset.opening_depreciation_date ?? ''
  const [openingAmount, setOpeningAmount] = useState(
    storedOpeningAmount > 0 ? String(storedOpeningAmount) : '',
  )
  const [openingDate, setOpeningDate] = useState(storedOpeningDate)
  const storedStartDate = asset.depreciation_start_date ?? ''
  const [startDate, setStartDate] = useState(storedStartDate)
  const [impairing, setImpairing] = useState(false)
  // K3 18.7: an intangible the user marks as the company's own development;
  // the fond för utvecklingsutgifter follows only marked assets. The server
  // keeps the mark to 1010-1019 and says so for any other account.
  const canMarkOwnDevelopment = asset.category === 'immaterial' || asset.own_development === true
  const [ownDevelopment, setOwnDevelopment] = useState(asset.own_development === true)
  const isLand = category === 'land'
  const writtenDown = netWrittenDown(asset)
  const optionLabel = (option: { value: AssetCategory; label: string }) =>
    option.value === 'land' ? t('category_land') : option.label
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Building and vehicle identification (Bolaget rollout only): saved
  // beside the asset, never part of the depreciation basis, so never locked.
  const tIdentification = useTranslations('bolaget_commitments.asset')
  const identification = useAssetIdentification(category)
  const [identificationValue, setIdentificationValue] = useState(identificationFrom(asset))

  const parsedCost = parseFloat(acquisitionCost)
  const parsedOpening = openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
  const remainingAfterOpening =
    Number.isFinite(parsedCost) && Number.isFinite(parsedOpening) && parsedOpening > 0
      ? roundOre(parsedCost - parsedOpening)
      : null

  const changeComponents = (drafts: ComponentDraft[]) => {
    setComponentDrafts(drafts)
    setComponentsTouched(true)
  }
  const toggleComponents = (next: boolean) => {
    setUseComponents(next)
    setComponentsTouched(true)
    if (next && componentDrafts.length === 0) setComponentDrafts([newComponentDraft()])
  }

  const handleSubmit = async () => {
    setError(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError('Namnet får inte vara tomt.')
      return
    }

    // Send only what actually changed. This keeps a name-only edit on a
    // depreciated asset from tripping the acquisition-basis guard, and avoids
    // clobbering a useful_life_months value that isn't a clean multiple of 12.
    const patch: Record<string, unknown> = {}

    if (trimmedName !== asset.name) patch.name = trimmedName
    if (canMarkOwnDevelopment && ownDevelopment !== (asset.own_development === true)) {
      patch.own_development = ownDevelopment
    }

    if (useComponents) {
      if (!basisLocked) {
        if (category !== asset.category) patch.category = category
        if (acquisitionDate !== asset.acquisition_date) patch.acquisition_date = acquisitionDate
      }
      if (componentsTouched) {
        const parsed = parseComponentDrafts(componentDrafts, t)
        if (parsed.error !== null) {
          setError(parsed.error)
          return
        }
        // An asset getting its first components keeps the cost on the books.
        if (!hasComponents && Math.abs(componentDraftsTotal(componentDrafts) - roundOre(Number(asset.acquisition_cost))) > 0.005) {
          setError(t('components.mismatch', { amount: formatCurrency(Number(asset.acquisition_cost)) }))
          return
        }
        patch.k3_components = parsed.components
      }
    } else {
      if (componentsTouched && hasComponents) patch.k3_components = null
      if (!basisLocked) {
        if (category !== asset.category) patch.category = category
        if (acquisitionDate !== asset.acquisition_date) patch.acquisition_date = acquisitionDate
        const cost = parseFloat(acquisitionCost)
        if (!Number.isFinite(cost) || cost <= 0) {
          setError('Anskaffningsvärdet måste vara större än 0.')
          return
        }
        if (cost !== Number(asset.acquisition_cost)) patch.acquisition_cost = cost

        // The start date (K3 17.18) is part of the basis too.
        if (!isLand && (startDate || null) !== (storedStartDate || null)) {
          patch.depreciation_start_date = startDate || null
        }

        // Opening accumulated depreciation: part of the depreciation basis, so
        // it locks together with date/cost/category. Judged against the values
        // the row will end up with; the server repeats the check.
        const opening = isLand || openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
        const issues = validateOpeningDepreciation({
          acquisition_cost: cost,
          acquisition_date: acquisitionDate,
          salvage_value: Number(asset.salvage_value ?? 0),
          opening_accumulated_depreciation: Number.isFinite(opening) ? opening : -1,
          opening_depreciation_date: openingDate || null,
        })
        if (issues.length > 0) {
          setError(t(`opening.error_${issues[0].kind}`))
          return
        }
        const nextOpening = roundOre(opening)
        const nextOpeningDate = nextOpening > 0 ? openingDate : null
        if (
          nextOpening !== storedOpeningAmount ||
          (nextOpeningDate ?? '') !== (storedOpeningDate || '')
        ) {
          patch.opening_accumulated_depreciation = nextOpening
          patch.opening_depreciation_date = nextOpeningDate
        }
      }

      // Mark has no useful life: the server keeps it at 0 months.
      const years = isLand ? 0 : parseInt(usefulLifeYears, 10)
      if (!isLand && (!Number.isFinite(years) || years <= 0)) {
        setError('Ange en avskrivningstid (minst 1 år).')
        return
      }
      const months = years * 12
      if (!isLand && months !== asset.useful_life_months) patch.useful_life_months = months
    }

    const identificationChanges = identification.available
      ? identificationPayload(category, identificationValue, identificationFrom(asset))
      : null
    if (identificationChanges === 'invalid') {
      setError(tIdentification('taxeringsvarde_invalid'))
      return
    }

    if (Object.keys(patch).length === 0 && !identificationChanges) {
      toast({ title: 'Inga ändringar', description: 'Inget att spara.' })
      onOpenChange(false)
      return
    }

    setSubmitting(true)
    try {
      if (Object.keys(patch).length > 0) {
        const res = await fetch(`/api/assets/${asset.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        const body = await res.json()
        if (!res.ok) {
          setError(getErrorMessage(body?.error ?? body) || 'Kunde inte spara ändringen.')
          return
        }
      }
      if (identificationChanges) {
        const saved = await saveAssetIdentification(asset.id, identificationChanges)
        if (!saved.ok) {
          setError(getErrorMessage(saved.body) || tIdentification('save_failed'))
          return
        }
      }
      toast({ title: 'Tillgång uppdaterad', description: trimmedName })
      onSaved()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isK3 || hasComponents ? 'sm:max-w-2xl' : 'sm:max-w-md'}>
        <DialogHeader>
          <DialogTitle>Ändra anläggningstillgång</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-asset-name">Namn</Label>
            <Input
              id="edit-asset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-asset-category">Kategori</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as AssetCategory)}
              disabled={basisLocked}
            >
              <SelectTrigger id="edit-asset-category">
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
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-asset-date">Anskaffat</Label>
              <Input
                id="edit-asset-date"
                type="date"
                value={acquisitionDate}
                onChange={(e) => setAcquisitionDate(e.target.value)}
                disabled={basisLocked}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-asset-cost">Anskaffningsvärde (kr)</Label>
              <Input
                id="edit-asset-cost"
                type="number"
                step="1"
                min="0"
                value={useComponents ? String(componentDraftsTotal(componentDrafts)) : acquisitionCost}
                onChange={(e) => setAcquisitionCost(e.target.value)}
                disabled={basisLocked || useComponents}
                className="tabular-nums"
              />
            </div>
          </div>

          <AssetIdentificationFields
            category={category}
            value={identificationValue}
            onChange={setIdentificationValue}
            available={identification.available}
            benefits={identification.benefits}
            idPrefix="edit-asset"
            disabled={!canWrite}
          />

          {basisLocked && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <LockClosedIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Anskaffningsdatum, anskaffningsvärde och kategori är låsta eftersom avskrivningar
                redan har bokförts. Återför avskrivningen (storno) eller använd avyttring för att
                ändra grunduppgifterna. Namn och avskrivningstid kan fortfarande justeras.
              </span>
            </div>
          )}

          {isK3 && canMarkOwnDevelopment && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={ownDevelopment}
                onCheckedChange={(checked) => setOwnDevelopment(checked === true)}
                disabled={!canWrite}
                className="mt-0.5"
              />
              <span>{t('own_development_mark')}</span>
            </label>
          )}

          {(isK3 || hasComponents) && (
            <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">{t('components.title')}</p>
                  <p className="text-xs text-muted-foreground">
                    {basisLocked && useComponents ? t('components.locked_hint') : t('components.hint')}
                  </p>
                </div>
                {!hasComponents && !basisLocked && (
                  <Button
                    type="button"
                    variant={useComponents ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => toggleComponents(!useComponents)}
                  >
                    {useComponents ? t('components.on') : t('components.off')}
                  </Button>
                )}
              </div>
              {useComponents && (
                <AssetComponentsEditor
                  drafts={componentDrafts}
                  onChange={changeComponents}
                  targetCost={hasComponents ? null : Number(asset.acquisition_cost)}
                  onReplace={
                    hasComponents && canWrite
                      ? (componentId) => setReplacing(registered.find((c) => c.id === componentId) ?? null)
                      : undefined
                  }
                  disabled={!canWrite}
                />
              )}
              {replaced.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{t('components.replaced_title')}</p>
                  {replaced.map((component) => (
                    <p key={component.id} className="text-xs tabular-nums text-muted-foreground">
                      {t('components.replaced_row', {
                        name: component.name,
                        date: component.derecognised_at ?? '',
                        cost: formatCurrency(Number(component.cost)),
                      })}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {!useComponents && !isLand && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-sm font-medium">{t('opening.title')}</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="edit-asset-opening-amount">{t('opening.amount_label')}</Label>
                <Input
                  id="edit-asset-opening-amount"
                  type="number"
                  step="0.01"
                  min="0"
                  value={openingAmount}
                  onChange={(e) => setOpeningAmount(e.target.value)}
                  disabled={basisLocked}
                  placeholder="0"
                  className="tabular-nums"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-asset-opening-date">{t('opening.date_label')}</Label>
                <Input
                  id="edit-asset-opening-date"
                  type="date"
                  value={openingDate}
                  onChange={(e) => setOpeningDate(e.target.value)}
                  disabled={basisLocked}
                  className="tabular-nums"
                />
              </div>
            </div>
            {remainingAfterOpening !== null && (
              <p className="text-xs tabular-nums text-foreground">
                {t('opening.remaining', { amount: formatCurrency(remainingAfterOpening) })}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {basisLocked ? t('opening.locked') : t('opening.hint')}
            </p>
          </div>
          )}

          {isLand && <p className="text-xs text-muted-foreground">{t('land_hint')}</p>}

          {!useComponents && !isLand && (
          <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-asset-life">Avskrivningstid (år)</Label>
            <Input
              id="edit-asset-life"
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
              <Label htmlFor="edit-asset-start">{t('start.label')}</Label>
              <HelpPopover>{t('start.help')}</HelpPopover>
            </div>
            <Input
              id="edit-asset-start"
              type="date"
              min={acquisitionDate}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={basisLocked}
              className="tabular-nums"
            />
          </div>
          </div>
          )}

          {!asset.disposed_at && (asset.category === 'building' || asset.category === 'land_improvement') && (
            <TaxPlanSection asset={asset} disabled={!canWrite} onSaved={onSaved} />
          )}

          {!asset.disposed_at && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">{t('impairment.title')}</p>
                  <HelpPopover>{t('impairment.hint')}</HelpPopover>
                </div>
                {writtenDown > 0 && (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {t('impairment.outstanding', { amount: formatCurrency(writtenDown) })}
                  </p>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setImpairing(true)} disabled={!canWrite}>
                {t('impairment.open')}
              </Button>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          {/* "Ta bort" sits apart from Avbryt/Spara: it is the exit for a row
              that never reached the books, the only case the page passes it. */}
          {onDelete && canWrite ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive sm:mr-auto"
              onClick={onDelete}
              disabled={submitting}
            >
              <TrashIcon className="mr-2 h-4 w-4" />
              {t('action_delete')}
            </Button>
          ) : (
            <span className="hidden sm:block" />
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Avbryt
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={!canWrite}
              loading={submitting}
              title={
                !canWrite ? 'Endast användare med skrivrättigheter kan ändra tillgångar.' : undefined
              }
            >
              {!canWrite && <LockClosedIcon className="mr-1 h-4 w-4" />}
              {submitting ? (
                'Sparar…'
              ) : (
                'Spara'
              )}
            </Button>
          </div>
        </DialogFooter>
        {impairing && (
          <ImpairAssetDialog
            asset={asset}
            open={impairing}
            onOpenChange={setImpairing}
            onPosted={() => {
              setImpairing(false)
              onSaved()
            }}
          />
        )}
        {replacing && (
          <ReplaceComponentDialog
            assetId={asset.id}
            component={replacing}
            open={replacing !== null}
            onOpenChange={(next) => {
              if (!next) setReplacing(null)
            }}
            onReplaced={() => {
              setReplacing(null)
              onSaved()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
