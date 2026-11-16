'use client'

import { PlusIcon, TrashIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { PERIODISERING_TEMPLATES, type PeriodiseringTemplate } from '@/lib/bokslut/accruals/templates'
import {
  newManualAccrualEntry,
  templateOf,
  type ManualAccrualEntry,
} from '@/lib/bokslut/accruals/manual-items'

function makeId() {
  return Math.random().toString(36).slice(2, 10)
}

interface ManualAccrualsEditorProps {
  entries: ManualAccrualEntry[]
  onChange: (entries: ManualAccrualEntry[]) => void
}

/**
 * The manual periodiseringar of a year-end close: one "Lägg till" per
 * PERIODISERING_TEMPLATES template (förutbetald hyra, försäkring,
 * prenumeration och övrig kostnad, upplupen kostnad, ränta och förbrukning,
 * förutbetald intäkt), then an editor per entry: amount, the balance and
 * result accounts (pre-filled, editable), the text, and kostnadsställe/projekt
 * for the result leg when the company uses dimensions. One editor for the
 * bokslut wizard and the periodisering page. The wording stays Swedish in both
 * locales, as the year-end wizard does.
 */
export function ManualAccrualsEditor({ entries, onChange }: ManualAccrualsEditorProps) {
  const add = (template: PeriodiseringTemplate) => onChange([...entries, newManualAccrualEntry(template, makeId())])
  const update = (id: string, patch: Partial<ManualAccrualEntry>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  const remove = (id: string) => onChange(entries.filter((e) => e.id !== id))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {PERIODISERING_TEMPLATES.map((t) => (
          <Button
            key={t.kind}
            variant="outline"
            onClick={() => add(t)}
            className="justify-start text-left h-auto px-3"
          >
            <PlusIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 min-w-0 py-2">
              <span className="block font-medium">{t.name}</span>
              <span className="block text-xs text-muted-foreground truncate">{t.hint}</span>
            </span>
          </Button>
        ))}
      </div>

      {entries.length > 0 && (
        <div className="space-y-3 pt-2">
          {entries.map((entry) => (
            <ManualAccrualEntryEditor
              key={entry.id}
              entry={entry}
              onChange={(patch) => update(entry.id, patch)}
              onRemove={() => remove(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ManualAccrualEntryEditor({
  entry,
  onChange,
  onRemove,
}: {
  entry: ManualAccrualEntry
  onChange: (patch: Partial<ManualAccrualEntry>) => void
  onRemove: () => void
}) {
  // Kostnadsställe/projekt for the result leg, shown only when the company
  // uses dimensions (read before the early return: hooks run every render).
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const template = templateOf(entry.templateKind)
  if (!template) return null
  const primaryLabel =
    template.side === 'prepaid'
      ? '17xx-konto'
      : template.side === 'deferred_revenue'
        ? '29xx-konto (deferred)'
        : '29xx-konto'
  const secondaryLabel = template.side === 'deferred_revenue' ? 'Intäktskonto' : 'Kostnadskonto'

  return (
    <div className="rounded-lg p-3 space-y-3 bg-control shadow-raised">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{template.name}</p>
        <Button variant="ghost" size="icon" onClick={onRemove} aria-label="Ta bort">
          <TrashIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Belopp (kr)</Label>
          <Input
            type="number"
            step="1"
            min="0"
            value={entry.amount}
            onChange={(e) => onChange({ amount: e.target.value })}
            className="tabular-nums h-8"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{primaryLabel}</Label>
          <Input
            value={entry.primaryAccount}
            onChange={(e) => onChange({ primaryAccount: e.target.value })}
            className="tabular-nums h-8"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{secondaryLabel}</Label>
          <Input
            value={entry.secondaryAccount}
            onChange={(e) => onChange({ secondaryAccount: e.target.value })}
            placeholder="t.ex. 6310"
            className="tabular-nums h-8"
          />
        </div>
        <div className="space-y-1 col-span-2">
          <Label className="text-xs">Beskrivning</Label>
          <Input
            value={entry.description}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="t.ex. Försäkring 2026"
            className="h-8"
          />
        </div>
        {dimensionsEnabled && (
          <div className="col-span-2">
            <LineDimensionFields
              dimensions={entry.dimensions}
              onChange={(dimNo, code) => {
                const next = { ...(entry.dimensions ?? {}) }
                const trimmed = code?.trim()
                if (trimmed) next[dimNo] = trimmed
                else delete next[dimNo]
                onChange({ dimensions: next })
              }}
              inputClassName="h-8"
            />
          </div>
        )}
      </div>
    </div>
  )
}
