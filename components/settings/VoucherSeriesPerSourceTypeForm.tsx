'use client'

import { useState } from 'react'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { Loader2 } from 'lucide-react'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import type { CompanySettings, JournalEntrySourceType } from '@/types'

const SERIES_OPTIONS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

// Subset of source_types presented to the user. The DB column accepts every
// JournalEntrySourceType, but several values (storno, correction, etc.) are
// derived from the original entry's series and would surprise the user if
// surfaced as configurable. We expose only the user-relevant subset; the
// engine still falls back to 'A' for the keys we hide.
const VISIBLE_SOURCE_TYPES: Array<{ key: JournalEntrySourceType; labelKey: string }> = [
  { key: 'manual', labelKey: 'manual' },
  { key: 'invoice_created', labelKey: 'invoice_created' },
  { key: 'invoice_paid', labelKey: 'invoice_paid' },
  { key: 'invoice_cash_payment', labelKey: 'invoice_cash_payment' },
  { key: 'supplier_invoice_registered', labelKey: 'supplier_invoice_registered' },
  { key: 'supplier_invoice_paid', labelKey: 'supplier_invoice_paid' },
  { key: 'supplier_invoice_cash_payment', labelKey: 'supplier_invoice_cash_payment' },
  { key: 'supplier_invoice_privately_paid', labelKey: 'supplier_invoice_privately_paid' },
  { key: 'salary_payment', labelKey: 'salary_payment' },
  { key: 'bank_transaction', labelKey: 'bank_transaction' },
  { key: 'reminder_fee', labelKey: 'reminder_fee' },
  { key: 'vat_settlement', labelKey: 'vat_settlement' },
  { key: 'opening_balance', labelKey: 'opening_balance' },
  { key: 'year_end', labelKey: 'year_end' },
]

// Swedish labels. Kept inline so this component is self-contained: these
// labels are bookkeeping-domain terms that intentionally stay Swedish across
// locales (see CLAUDE.md i18n table).
const SV_LABELS: Record<string, string> = {
  manual: 'Manuella verifikat',
  invoice_created: 'Kundfakturor (skapande)',
  invoice_paid: 'Kundfakturor (betalning, fakturametod)',
  invoice_cash_payment: 'Kundfakturor (betalning, kontantmetod)',
  supplier_invoice_registered: 'Leverantörsfakturor (registrering)',
  supplier_invoice_paid: 'Leverantörsfakturor (betalning, fakturametod)',
  supplier_invoice_cash_payment: 'Leverantörsfakturor (betalning, kontantmetod)',
  supplier_invoice_privately_paid: 'Leverantörsfakturor (privat utlägg)',
  salary_payment: 'Lön',
  bank_transaction: 'Banktransaktioner',
  reminder_fee: 'Påminnelseavgifter',
  vat_settlement: 'Momsredovisning',
  opening_balance: 'Ingående balanser',
  year_end: 'Bokslut',
}

interface Props {
  settings: CompanySettings
  onSettingsUpdated: (settings: Partial<CompanySettings>) => void
}

export function VoucherSeriesPerSourceTypeForm({ settings, onSettingsUpdated }: Props) {
  const { toast } = useToast()
  const initialMap = settings.default_voucher_series_per_source_type || {}
  const [draft, setDraft] = useState<Partial<Record<JournalEntrySourceType, string>>>(
    initialMap as Partial<Record<JournalEntrySourceType, string>>,
  )
  const [isSaving, setIsSaving] = useState(false)

  const handleChange = (sourceType: JournalEntrySourceType, value: string) => {
    setDraft((prev) => ({ ...prev, [sourceType]: value }))
  }

  const hasChanges =
    JSON.stringify(draft) !== JSON.stringify(initialMap)

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_voucher_series_per_source_type: draft,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte spara',
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      onSettingsUpdated({
        default_voucher_series_per_source_type: draft as Record<JournalEntrySourceType, string>,
      })
      toast({
        title: 'Verifikationsserier sparade',
        description: 'Nya verifikat använder de uppdaterade serierna.',
      })
    } catch (err) {
      toast({
        title: 'Kunde inte spara',
        description: getErrorMessage(err, { context: 'settings' }),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Verifikationsserier per typ
        </h2>
        <p className="text-xs text-muted-foreground">
          Tilldela en standardserie per typ av verifikat. Vanlig svensk
          praxis: leverantörsfakturor på serie B, löner på serie C, övrigt på
          serie A. Kan alltid ändras per verifikat när du bokför.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {VISIBLE_SOURCE_TYPES.map(({ key, labelKey }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <Label
              htmlFor={`series-${key}`}
              className="text-sm text-foreground flex-1 cursor-pointer"
            >
              {SV_LABELS[labelKey] ?? key}
            </Label>
            <Select
              value={(draft[key] as string | undefined) || 'A'}
              onValueChange={(v) => handleChange(key, v)}
            >
              <SelectTrigger
                id={`series-${key}`}
                className="w-16 font-mono"
                aria-label={SV_LABELS[labelKey] ?? key}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SERIES_OPTIONS.map((letter) => (
                  <SelectItem key={letter} value={letter} className="font-mono">
                    {letter}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="flex justify-end pt-2">
        <Button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Spara serier
        </Button>
      </div>
    </section>
  )
}
