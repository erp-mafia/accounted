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
import { AlertTriangle, Loader2, Lock } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { Asset, AssetCategory, DepreciationMethod } from '@/types'

/** The list route annotates each asset with whether any depreciation has been
 *  posted against it. When true, the acquisition-basis fields are locked. */
type EditableAsset = Asset & { has_posted_depreciation?: boolean }

interface EditAssetDialogProps {
  asset: EditableAsset
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

// Same category labels and depreciation hints as CreateAssetDialog (kept in
// sync deliberately: this register surface is Swedish-only, like creation).
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

const DEPRECIATION_METHOD_OPTIONS: { value: DepreciationMethod; label: string; hint: string }[] = [
  {
    value: 'linear',
    label: 'Linjär',
    hint: 'Planenlig raklinje över nyttjandeperioden (ÅRL 4 kap 4§).',
  },
  {
    value: 'declining_balance_30',
    label: 'Räkenskapsenlig 30 %',
    hint: 'Huvudregeln (IL 18 kap 13§): 30 % degressivt på avskrivningsunderlaget.',
  },
  {
    value: 'declining_balance_20',
    label: 'Räkenskapsenlig 20 %',
    hint: 'Kompletteringsregeln (IL 18 kap 17§): 20 % degressivt. Vanlig för byggnader.',
  },
  {
    value: 'restvardesavskrivning_25',
    label: 'Restvärdeavskrivning 25 %',
    hint: 'IL 18 kap 13§ st.3: 25 % degressivt ner till angivet restvärde.',
  },
]

export function EditAssetDialog({ asset, open, onOpenChange, onSaved }: EditAssetDialogProps) {
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
  const [depreciationMethod, setDepreciationMethod] = useState<DepreciationMethod>(
    asset.depreciation_method,
  )
  const [restvardeTarget, setRestvardeTarget] = useState(
    asset.restvarde_target != null ? String(asset.restvarde_target) : '',
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isRestvarde = depreciationMethod === 'restvardesavskrivning_25'
  const methodHint =
    DEPRECIATION_METHOD_OPTIONS.find((o) => o.value === depreciationMethod)?.hint ?? ''

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
    }

    const years = parseInt(usefulLifeYears, 10)
    if (!Number.isFinite(years) || years <= 0) {
      setError('Ange en avskrivningstid (minst 1 år).')
      return
    }
    const months = years * 12
    if (months !== asset.useful_life_months) patch.useful_life_months = months

    if (depreciationMethod !== asset.depreciation_method) {
      patch.depreciation_method = depreciationMethod
    }

    if (isRestvarde) {
      const target = parseFloat(restvardeTarget)
      const cost = !basisLocked ? parseFloat(acquisitionCost) : Number(asset.acquisition_cost)
      if (!Number.isFinite(target) || target < 0) {
        setError('Ange ett restvärde (0 kr eller högre).')
        return
      }
      if (Number.isFinite(cost) && target >= cost) {
        setError('Restvärdet måste vara lägre än anskaffningsvärdet.')
        return
      }
      // Send the target when switching into restvärde or when it changed, so
      // the method/target biconditional always holds.
      if (
        depreciationMethod !== asset.depreciation_method ||
        target !== Number(asset.restvarde_target)
      ) {
        patch.restvarde_target = target
      }
    }

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
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Anskaffningsdatum, anskaffningsvärde och kategori är låsta eftersom avskrivningar
                redan har bokförts. Återför avskrivningen (storno) eller använd avyttring för att
                ändra grunduppgifterna. Namn, avskrivningstid och metod kan fortfarande justeras.
              </span>
            </div>
          )}

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
            <Label htmlFor="edit-asset-method">Avskrivningsmetod</Label>
            <Select
              value={depreciationMethod}
              onValueChange={(v) => setDepreciationMethod(v as DepreciationMethod)}
            >
              <SelectTrigger id="edit-asset-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEPRECIATION_METHOD_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{methodHint}</p>
          </div>

          {basisLocked && depreciationMethod !== asset.depreciation_method && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Byte av avskrivningsmetod efter att avskrivning påbörjats. Enligt K2
                (BFNAR 2016:10 p. 10.26) ska vald metod tillämpas konsekvent: ändra
                bara vid särskilda skäl och lämna i så fall upplysning i bokslutet.
                Ändringen gäller framåt; redan bokförda avskrivningar påverkas inte.
              </span>
            </div>
          )}

          {isRestvarde && (
            <div className="space-y-1.5">
              <Label htmlFor="edit-asset-restvarde">Restvärde (kr)</Label>
              <Input
                id="edit-asset-restvarde"
                type="number"
                min="0"
                step="1"
                value={restvardeTarget}
                onChange={(e) => setRestvardeTarget(e.target.value)}
                placeholder="t.ex. 5000"
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Avskrivningen stannar när bokfört värde når restvärdet. Restvärdet måste vara lägre
                än anskaffningsvärdet.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Avbryt
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!canWrite || submitting}
            title={
              !canWrite ? 'Endast användare med skrivrättigheter kan ändra tillgångar.' : undefined
            }
          >
            {!canWrite && <Lock className="mr-1 h-4 w-4" />}
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
              </>
            ) : (
              'Spara'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
