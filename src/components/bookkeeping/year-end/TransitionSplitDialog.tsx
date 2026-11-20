'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlusIcon, XMarkIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { parseAmountInput, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import type { TransitionSplitCandidate } from '@/lib/bokslut/assets/transition-split-service'

interface ComponentDraft {
  key: number
  name: string
  carrying: string
  life: string
  land: boolean
  salvage: string
}

let draftKey = 0
function componentDraft(component?: TransitionSplitCandidate['components'][number]): ComponentDraft {
  draftKey += 1
  return {
    key: draftKey,
    name: component?.name ?? '',
    carrying: component ? String(component.carrying_amount) : '',
    life: component?.useful_life_months ? String(component.useful_life_months) : '',
    land: component ? component.useful_life_months === null : false,
    salvage: component?.salvage_value ? String(component.salvage_value) : '',
  }
}

/**
 * Split an asset on its significant components at the transition to K3
 * (K3 35.18): each component's carrying amount at the transition date and
 * its useful life counted from when the asset was first used. The server
 * spreads the accumulated depreciation over the components; the split books
 * nothing and can be undone while nothing is posted per component.
 */
export function TransitionSplitDialog({
  asset,
  open,
  onOpenChange,
  onSaved,
}: {
  asset: TransitionSplitCandidate
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const t = useTranslations('k3_transition')
  const [rows, setRows] = useState<ComponentDraft[]>(() =>
    asset.components.length > 0 ? asset.components.map(componentDraft) : [componentDraft(), componentDraft()],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = (key: number, patch: Partial<ComponentDraft>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  const sum = roundOre(rows.reduce((total, row) => total + (parseAmountInput(row.carrying) ?? 0), 0))

  const submit = async (components: unknown[]) => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/assets/${asset.asset_id}/transition-split`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getErrorMessage(body?.error) || t('save_failed'))
        return
      }
      onSaved()
      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err) || t('save_failed'))
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    const components = []
    for (const row of rows) {
      const carrying = parseAmountInput(row.carrying)
      const life = row.land ? null : Number.parseInt(row.life, 10)
      const salvage = row.salvage.trim() ? parseAmountInput(row.salvage) : 0
      if (!row.name.trim() || carrying === null || salvage === null || (life !== null && !(life > 0))) {
        setError(t('save_failed'))
        return
      }
      components.push({ name: row.name.trim(), carrying_amount: roundOre(carrying), useful_life_months: life, salvage_value: roundOre(salvage) })
    }
    void submit(components)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>{t('split_title', { name: asset.name })}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('split_intro', { amount: formatCurrency(asset.carrying_amount), months: asset.months_used })}
        </p>
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.key} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-12 space-y-1 sm:col-span-4">
                <Label htmlFor={`split-name-${row.key}`} className="text-xs text-muted-foreground">{t('component_name')}</Label>
                <Input id={`split-name-${row.key}`} value={row.name} onChange={(e) => update(row.key, { name: e.target.value })} />
              </div>
              <div className="col-span-6 space-y-1 sm:col-span-3">
                <Label htmlFor={`split-carrying-${row.key}`} className="text-xs text-muted-foreground">{t('component_carrying')}</Label>
                <Input
                  id={`split-carrying-${row.key}`}
                  type="number"
                  step="0.01"
                  value={row.carrying}
                  onChange={(e) => update(row.key, { carrying: e.target.value })}
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-5 space-y-1 sm:col-span-2">
                <Label htmlFor={`split-life-${row.key}`} className="text-xs text-muted-foreground">{t('component_life')}</Label>
                <Input
                  id={`split-life-${row.key}`}
                  type="number"
                  step="1"
                  value={row.land ? '' : row.life}
                  disabled={row.land}
                  onChange={(e) => update(row.key, { life: e.target.value })}
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-6 space-y-1 sm:col-span-2">
                <Label htmlFor={`split-salvage-${row.key}`} className="text-xs text-muted-foreground">{t('component_salvage')}</Label>
                <Input
                  id={`split-salvage-${row.key}`}
                  type="number"
                  step="0.01"
                  value={row.salvage}
                  onChange={(e) => update(row.key, { salvage: e.target.value })}
                  className="tabular-nums"
                />
              </div>
              <div className="col-span-1 flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))}
                  aria-label={t('component_remove', { name: row.name || '' })}
                >
                  <XMarkIcon className="h-4 w-4" />
                </Button>
              </div>
              <label className="col-span-12 flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox checked={row.land} onCheckedChange={(checked) => update(row.key, { land: checked === true })} />
                {t('component_land')}
              </label>
            </div>
          ))}
          <div className="flex items-center justify-between gap-2">
            <Button type="button" variant="outline" onClick={() => setRows((current) => [...current, componentDraft()])}>
              <PlusIcon className="h-4 w-4" /> {t('component_add')}
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {t('split_sum', { sum: formatCurrency(sum), total: formatCurrency(asset.carrying_amount) })}
            </span>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          {asset.status === 'split' && (
            <Button variant="ghost" onClick={() => void submit([])} disabled={busy}>
              {t('split_undo')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={save} loading={busy}>
            {t('split_save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
