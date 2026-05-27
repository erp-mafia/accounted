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
import { Loader2, Plus, X } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { formatCurrency } from '@/lib/utils'
import type { AssetCategory, DepreciationMethod, K3Component } from '@/types'

interface CreateAssetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}

/** Editor row state — strings so the user can clear inputs without zeroing
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
// avskrivning. Building / markanläggning values are conservative — IL 19/20
// kap may allow longer (50 yr) or shorter (10 yr) depending on byggnadstyp.
const CATEGORY_OPTIONS: { value: AssetCategory; label: string; defaultYears: number }[] = [
  { value: 'computer', label: 'Dator / IT-utrustning', defaultYears: 3 },
  { value: 'equipment', label: 'Inventarier', defaultYears: 5 },
  { value: 'machinery', label: 'Maskiner', defaultYears: 10 },
  { value: 'vehicle', label: 'Fordon', defaultYears: 5 },
  { value: 'building', label: 'Byggnad', defaultYears: 25 },
  { value: 'land_improvement', label: 'Markanläggning', defaultYears: 10 },
  { value: 'immaterial', label: 'Immateriell tillgång', defaultYears: 5 },
  { value: 'other_tangible', label: 'Övrig materiell tillgång', defaultYears: 5 },
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
    hint: 'Huvudregeln (IL 18 kap 13§) — 30 % degressivt på avskrivningsunderlaget.',
  },
  {
    value: 'declining_balance_20',
    label: 'Räkenskapsenlig 20 %',
    hint: 'Kompletteringsregeln (IL 18 kap 17§) — 20 % degressivt. Vanlig för byggnader.',
  },
  {
    value: 'restvardesavskrivning_25',
    label: 'Restvärdeavskrivning 25 %',
    hint: 'IL 18 kap 13§ st.3 — 25 % degressivt ner till angivet restvärde.',
  },
]

export function CreateAssetDialog({ open, onOpenChange, onCreated }: CreateAssetDialogProps) {
  const { toast } = useToast()
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
  const [depreciationMethod, setDepreciationMethod] = useState<DepreciationMethod>('linear')
  const [restvardeTarget, setRestvardeTarget] = useState('')
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

  const isRestvarde = depreciationMethod === 'restvardesavskrivning_25'
  const methodHint =
    DEPRECIATION_METHOD_OPTIONS.find((o) => o.value === depreciationMethod)?.hint ?? ''

  const totalComponentCost = useMemo(() => {
    return componentRows.reduce((sum, row) => {
      const v = parseFloat(row.cost)
      return Number.isFinite(v) ? sum + v : sum
    }, 0)
  }, [componentRows])

  const parsedAcquisitionCost = parseFloat(acquisitionCost)
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
      setError('Fyll i namn, anskaffningsvärde och avskrivningstid.')
      return
    }
    let restvardeTargetNumber: number | null = null
    if (isRestvarde) {
      const parsed = parseFloat(restvardeTarget)
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('Ange ett restvärde (0 kr eller högre).')
        return
      }
      if (parsed >= cost) {
        setError('Restvärdet måste vara lägre än anskaffningsvärdet.')
        return
      }
      restvardeTargetNumber = parsed
    }
    // K3 components — only when both the framework permits (gate at API)
    // and the user opted into the section. Empty array is invalid (the
    // validator rejects it) so the dialog also flips back to "off" when
    // every row is removed.
    let componentsPayload: K3Component[] | null = null
    if (useComponents && isK3) {
      if (componentRows.length === 0) {
        setError('Lägg till minst en komponent eller stäng av komponentuppdelningen.')
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
          setError(`Komponent ${index + 1}: ange ett namn.`)
          return
        }
        if (!Number.isFinite(componentCost) || componentCost <= 0) {
          setError(`${trimmedName}: anskaffningsvärdet måste vara större än 0.`)
          return
        }
        if (!Number.isFinite(months) || months <= 0) {
          setError(`${trimmedName}: ange ett positivt heltal månader.`)
          return
        }
        if (salvage !== undefined && (!Number.isFinite(salvage) || salvage < 0)) {
          setError(`${trimmedName}: restvärdet får inte vara negativt.`)
          return
        }
        if (salvage !== undefined && salvage > componentCost) {
          setError(`${trimmedName}: restvärdet får inte överstiga anskaffningsvärdet.`)
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
          `Komponenter summerar till ${formatCurrency(sum)} men anskaffningsvärdet är ${formatCurrency(cost)}.`,
        )
        return
      }
      componentsPayload = parsed
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
          depreciation_method: depreciationMethod,
          ...(restvardeTargetNumber !== null
            ? { restvarde_target: restvardeTargetNumber }
            : {}),
          ...(componentsPayload !== null ? { k3_components: componentsPayload } : {}),
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(body?.error?.message ?? 'Kunde inte spara tillgången')
        return
      }
      toast({ title: 'Tillgång sparad', description: name.trim() })
      // Reset form for next entry
      setName('')
      setAcquisitionCost('')
      setDepreciationMethod('linear')
      setRestvardeTarget('')
      setUseComponents(false)
      setComponentRows([])
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
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
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
              <Label htmlFor="asset-cost">Anskaffningsvärde (kr)</Label>
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
          <div className="space-y-1.5">
            <Label htmlFor="asset-life">Avskrivningstid (år)</Label>
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
              K2-schablon för redovisning: datorer 3 år, inventarier 5 år, byggnader 25 år.
              För skattemässig avskrivning kan annan livslängd gälla (IL 18–20 kap).
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="asset-method">Avskrivningsmetod</Label>
            <Select
              value={depreciationMethod}
              onValueChange={(v) => setDepreciationMethod(v as DepreciationMethod)}
            >
              <SelectTrigger id="asset-method">
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
          {isRestvarde && (
            <div className="space-y-1.5">
              <Label htmlFor="asset-restvarde">Restvärde (kr)</Label>
              <Input
                id="asset-restvarde"
                type="number"
                min="0"
                step="1"
                value={restvardeTarget}
                onChange={(e) => setRestvardeTarget(e.target.value)}
                placeholder="t.ex. 5000"
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Avskrivningen stannar när bokfört värde når restvärdet. Restvärdet
                måste vara lägre än anskaffningsvärdet.
              </p>
            </div>
          )}
          {isK3 && (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    Avancerat — komponentuppdelning
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    K3 (BFNAR 2012:1 17.4) — när väsentliga komponenter har olika nyttjandeperiod
                    skrivs varje komponent av för sig. Typisk för fastigheter (tak, fasad, stomme,
                    installationer).
                  </p>
                </div>
                <Button
                  type="button"
                  variant={useComponents ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => toggleUseComponents(!useComponents)}
                >
                  {useComponents ? 'Aktiverad' : 'Aktivera'}
                </Button>
              </div>

              {useComponents && (
                <div className="space-y-2">
                  {componentRows.map((row, idx) => (
                    <div
                      key={row.id}
                      className="grid grid-cols-12 items-end gap-2 rounded-md border border-border bg-background p-2"
                    >
                      <div className="col-span-12 sm:col-span-4 space-y-1">
                        <Label
                          htmlFor={`cmp-name-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          Komponent
                        </Label>
                        <Input
                          id={`cmp-name-${row.id}`}
                          value={row.name}
                          onChange={(e) =>
                            updateComponentRow(row.id, { name: e.target.value })
                          }
                          placeholder={idx === 0 ? 't.ex. Stomme' : 'Namn'}
                        />
                      </div>
                      <div className="col-span-6 sm:col-span-3 space-y-1">
                        <Label
                          htmlFor={`cmp-cost-${row.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          Kostnad (kr)
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
                          Liv (mån)
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
                          Restvärde
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
                          aria-label="Ta bort komponent"
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
                      <Plus className="mr-1 h-4 w-4" /> Lägg till komponent
                    </Button>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      Summa komponenter:{' '}
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
                      Komponenter summerar inte till anskaffningsvärdet (
                      {formatCurrency(parsedAcquisitionCost)}).
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Tips:</strong> Anskaffningen måste redan vara
            bokförd (debet på 1xxx-kontot mot t.ex. 1930/2440) — registret bokför inte
            själva köpet. Det här registret styr enbart de planenliga avskrivningarna under
            bokslutet.
          </div>
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
          <Button onClick={handleSubmit} disabled={submitting}>
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
