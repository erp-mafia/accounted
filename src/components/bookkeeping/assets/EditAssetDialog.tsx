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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Lock, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { validateOpeningDepreciation } from '@/lib/bokslut/assets/opening-depreciation'
import type { Asset, AssetCategory } from '@/types'

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
  // Once depreciation has been booked, acquisition date/cost/category are
  // locked: a real change has to go through storno. The server enforces the
  // same rule (ASSET_CORRECTION_BLOCKED); this just makes it visible up front.
  const basisLocked = asset.has_posted_depreciation === true

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
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedCost = parseFloat(acquisitionCost)
  const parsedOpening = openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
  const remainingAfterOpening =
    Number.isFinite(parsedCost) && Number.isFinite(parsedOpening) && parsedOpening > 0
      ? roundOre(parsedCost - parsedOpening)
      : null

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

    if (!basisLocked) {
      if (category !== asset.category) patch.category = category
      if (acquisitionDate !== asset.acquisition_date) patch.acquisition_date = acquisitionDate
      const cost = parseFloat(acquisitionCost)
      if (!Number.isFinite(cost) || cost <= 0) {
        setError('Anskaffningsvärdet måste vara större än 0.')
        return
      }
      if (cost !== Number(asset.acquisition_cost)) patch.acquisition_cost = cost

      // Opening accumulated depreciation: part of the depreciation basis, so
      // it locks together with date/cost/category. Judged against the values
      // the row will end up with; the server repeats the check.
      const opening = openingAmount.trim() === '' ? 0 : parseFloat(openingAmount)
      const issues = validateOpeningDepreciation({
        acquisition_cost: cost,
        acquisition_date: acquisitionDate,
        salvage_value: Number(asset.salvage_value ?? 0),
        opening_accumulated_depreciation: Number.isFinite(opening) ? opening : -1,
        opening_depreciation_date: openingDate || null,
        k3_components: asset.k3_components,
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

    const years = parseInt(usefulLifeYears, 10)
    if (!Number.isFinite(years) || years <= 0) {
      setError('Ange en avskrivningstid (minst 1 år).')
      return
    }
    const months = years * 12
    if (months !== asset.useful_life_months) patch.useful_life_months = months

    if (Object.keys(patch).length === 0) {
      toast({ title: 'Inga ändringar', description: 'Inget att spara.' })
      onOpenChange(false)
      return
    }

    setSubmitting(true)
    try {
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
      <DialogContent className="sm:max-w-md">
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
                    {o.label}
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
                value={acquisitionCost}
                onChange={(e) => setAcquisitionCost(e.target.value)}
                disabled={basisLocked}
                className="tabular-nums"
              />
            </div>
          </div>

          {basisLocked && (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Anskaffningsdatum, anskaffningsvärde och kategori är låsta eftersom avskrivningar
                redan har bokförts. Återför avskrivningen (storno) eller använd avyttring för att
                ändra grunduppgifterna. Namn och avskrivningstid kan fortfarande justeras.
              </span>
            </div>
          )}

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
              <Trash2 className="mr-2 h-4 w-4" />
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
              {!canWrite && <Lock className="mr-1 h-4 w-4" />}
              {submitting ? (
                'Sparar…'
              ) : (
                'Spara'
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
