'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ChevronDown, Loader2 } from 'lucide-react'
import {
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { VOUCHER_SERIES_PRESETS } from '@/lib/bookkeeping/voucher-series-resolver'
import type { CompanySettings, JournalEntrySourceType } from '@/types'

const SERIES_LETTER_RE = /^[A-Z]$/

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
  { key: 'webshop_order', labelKey: 'webshop_order' },
  { key: 'vat_settlement', labelKey: 'vat_settlement' },
  { key: 'opening_balance', labelKey: 'opening_balance' },
  { key: 'year_end', labelKey: 'year_end' },
]

// The everyday types stay visible; the long tail folds behind "Visa alla".
// Keeps the map's iteration order intact: we only split it, never reorder.
const ALWAYS_VISIBLE_COUNT = 3

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
  webshop_order: 'Webshopordrar',
  vat_settlement: 'Momsredovisning',
  opening_balance: 'Ingående balanser',
  year_end: 'Bokslut',
}

interface Props {
  settings: CompanySettings
  onSettingsUpdated: (settings: Partial<CompanySettings>) => void
}

export function VoucherSeriesPerSourceTypeForm({ settings, onSettingsUpdated }: Props) {
  // Generic fold labels ("Visa alla (n)" / "Visa färre") shared with the
  // dashboard widgets; the domain labels themselves stay hardcoded Swedish.
  const tCommon = useTranslations('dashboard')
  const { toast } = useToast()
  const initialMap = settings.default_voucher_series_per_source_type || {}
  const [draft, setDraft] = useState<Partial<Record<JournalEntrySourceType, string>>>(
    initialMap as Partial<Record<JournalEntrySourceType, string>>,
  )
  const [isSaving, setIsSaving] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Same closed list as the manual verifikat form and the per-bankkonto
  // picker: the fixed Swedish presets, then any letter the company already
  // uses that the presets do not cover, so no saved value falls out of the
  // list. A free A-Z list would let a typo start an undocumented series.
  const seriesOptions = useMemo(() => {
    const preset = new Set(VOUCHER_SERIES_PRESETS.map((p) => p.letter))
    const extras = [settings.default_voucher_series, ...Object.values(draft)].filter(
      (v): v is string => typeof v === 'string' && SERIES_LETTER_RE.test(v) && !preset.has(v),
    )
    const uniqueExtras = Array.from(new Set(extras)).sort()
    return [
      ...VOUCHER_SERIES_PRESETS,
      ...uniqueExtras.map((letter) => ({ letter, label: '' })),
    ]
  }, [settings.default_voucher_series, draft])

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

  const renderRow = (
    { key, labelKey }: (typeof VISIBLE_SOURCE_TYPES)[number],
    borderless = false,
  ) => (
    <SettingsRow
      key={key}
      label={SV_LABELS[labelKey] ?? key}
      htmlFor={`series-${key}`}
      borderless={borderless}
    >
      <SettingsSelect
        id={`series-${key}`}
        value={(draft[key] as string | undefined) || 'A'}
        onChange={(e) => handleChange(key, e.target.value)}
        className="font-mono"
      >
        {seriesOptions.map((option) => (
          <option key={option.letter} value={option.letter}>
            {option.label ? `${option.letter}  ${option.label}` : option.letter}
          </option>
        ))}
      </SettingsSelect>
    </SettingsRow>
  )

  const alwaysVisible = VISIBLE_SOURCE_TYPES.slice(0, ALWAYS_VISIBLE_COUNT)
  const folded = VISIBLE_SOURCE_TYPES.slice(ALWAYS_VISIBLE_COUNT)

  return (
    <SettingsGroup
      label="Verifikationsserier per typ"
      help="Tilldela en standardserie per typ av verifikat. Vanlig svensk praxis: kundfakturor på serie B, leverantörsfakturor på serie D, löner på serie K, övrigt på serie A. Kan alltid ändras per verifikat när du bokför."
    >
      {alwaysVisible.map((entry, i) =>
        // The last always-visible row sits right above the fold toggle:
        // drop its hairline so the fold reads as part of the same list.
        renderRow(entry, i === alwaysVisible.length - 1),
      )}

      <button
        type="button"
        onClick={() => setShowAll((v) => !v)}
        aria-expanded={showAll}
        className="flex items-center gap-1.5 px-1 py-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 transition-transform duration-150', showAll && 'rotate-180')}
        />
        {showAll ? tCommon('show_less') : tCommon('show_all', { count: folded.length })}
      </button>

      <SettingsReveal open={showAll} indent={false}>
        {folded.map((entry, i) => renderRow(entry, i === folded.length - 1))}
      </SettingsReveal>

      <div className="flex justify-end px-1 pt-4">
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
        >
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Spara serier
        </Button>
      </div>
    </SettingsGroup>
  )
}
