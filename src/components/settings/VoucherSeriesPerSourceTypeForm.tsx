'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ChevronDown } from 'lucide-react'
import {
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { cn } from '@/lib/utils'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  buildVoucherSeriesOptions,
  isStandardVoucherSeriesMap,
  STANDARD_VOUCHER_SERIES_MAP,
} from '@/lib/bookkeeping/voucher-series-resolver'
import type { CompanySettings, JournalEntrySourceType } from '@/types'

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

// The payment types that belong to one bokföringsmetod. Under the other
// method their rows are dimmed, never hidden (#2184): the choice stays visible
// and editable, so a company that switches method finds it already made and
// nothing in the map goes stale out of sight. Only the payment rows are
// bound to a method; registering an invoice happens under both.
const METHOD_BOUND: Partial<Record<JournalEntrySourceType, 'accrual' | 'cash'>> = {
  invoice_paid: 'accrual',
  supplier_invoice_paid: 'accrual',
  invoice_cash_payment: 'cash',
  supplier_invoice_cash_payment: 'cash',
}

interface Props {
  settings: CompanySettings
  onSettingsUpdated: (settings: Partial<CompanySettings>) => void
}

export function VoucherSeriesPerSourceTypeForm({ settings, onSettingsUpdated }: Props) {
  // Generic fold labels ("Visa alla (n)" / "Visa färre") shared with the
  // dashboard widgets.
  const tCommon = useTranslations('dashboard')
  const t = useTranslations('settings_bookkeeping')
  const { toast } = useToast()
  const initialMap = settings.default_voucher_series_per_source_type || {}
  const [draft, setDraft] = useState<Partial<Record<JournalEntrySourceType, string>>>(
    initialMap as Partial<Record<JournalEntrySourceType, string>>,
  )
  const [isSaving, setIsSaving] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const method: 'accrual' | 'cash' = settings.accounting_method === 'cash' ? 'cash' : 'accrual'

  // Same closed list as the manual verifikat form and the per-bankkonto
  // picker: the fixed Swedish presets, then any letter already configured in
  // settings that the presets do not cover. The saved map is read alongside
  // the draft so a non-preset letter stays selectable after the user changes
  // that row away from it (otherwise a misclick could not be undone without
  // a reload) and so a letter that lands in settings after mount is offered.
  // A free A-Z list would let a typo start an undocumented series. Names
  // come from the company's own voucher_series_labels, presets as fallback.
  const seriesOptions = useMemo(
    () =>
      buildVoucherSeriesOptions(settings.voucher_series_labels, [
        settings.default_voucher_series,
        ...Object.values(settings.default_voucher_series_per_source_type ?? {}),
        ...Object.values(draft),
      ]),
    [
      settings.voucher_series_labels,
      settings.default_voucher_series,
      settings.default_voucher_series_per_source_type,
      draft,
    ],
  )

  // One literal key per source type so the message-keys test can verify them.
  const sourceTypeLabel = (labelKey: string): string | null => {
    switch (labelKey) {
      case 'manual': return t('series_type_manual')
      case 'invoice_created': return t('series_type_invoice_created')
      case 'invoice_paid': return t('series_type_invoice_paid')
      case 'invoice_cash_payment': return t('series_type_invoice_cash_payment')
      case 'supplier_invoice_registered': return t('series_type_supplier_invoice_registered')
      case 'supplier_invoice_paid': return t('series_type_supplier_invoice_paid')
      case 'supplier_invoice_cash_payment': return t('series_type_supplier_invoice_cash_payment')
      case 'supplier_invoice_privately_paid': return t('series_type_supplier_invoice_privately_paid')
      case 'salary_payment': return t('series_type_salary_payment')
      case 'bank_transaction': return t('series_type_bank_transaction')
      case 'reminder_fee': return t('series_type_reminder_fee')
      case 'webshop_order': return t('series_type_webshop_order')
      case 'vat_settlement': return t('series_type_vat_settlement')
      case 'opening_balance': return t('series_type_opening_balance')
      case 'year_end': return t('series_type_year_end')
      default: return null
    }
  }

  const handleChange = (sourceType: JournalEntrySourceType, value: string) => {
    setDraft((prev) => ({ ...prev, [sourceType]: value }))
  }

  const hasChanges =
    JSON.stringify(draft) !== JSON.stringify(initialMap)

  // Fill the form with the set a new company starts with. Fills, never
  // saves: a series switch mid-year is a deliberate act, so the fold opens to
  // show every row it changes and the user commits with Spara serier.
  const onStandardSet = isStandardVoucherSeriesMap(draft)
  const handleUseStandardSet = () => {
    setDraft({ ...STANDARD_VOUCHER_SERIES_MAP })
    setShowAll(true)
  }

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
          title: t('series_save_failed'),
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      onSettingsUpdated({
        default_voucher_series_per_source_type: draft as Record<JournalEntrySourceType, string>,
      })
      toast({
        title: t('series_saved_title'),
        description: t('series_saved_description'),
      })
    } catch (err) {
      toast({
        title: t('series_save_failed'),
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
  ) => {
    const boundTo = METHOD_BOUND[key]
    const dimmed = boundTo !== undefined && boundTo !== method
    return (
      <SettingsRow
        key={key}
        label={sourceTypeLabel(labelKey) ?? key}
        htmlFor={`series-${key}`}
        help={
          dimmed ? t(boundTo === 'cash' ? 'series_row_cash_only' : 'series_row_accrual_only') : undefined
        }
        borderless={borderless}
        className={dimmed ? 'opacity-60' : undefined}
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
  }

  const alwaysVisible = VISIBLE_SOURCE_TYPES.slice(0, ALWAYS_VISIBLE_COUNT)
  const folded = VISIBLE_SOURCE_TYPES.slice(ALWAYS_VISIBLE_COUNT)

  return (
    <SettingsGroup
      label={t('series_per_type_label')}
      help={t('series_per_type_help')}
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

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-4">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleUseStandardSet}
            disabled={onStandardSet || isSaving}
          >
            {t('series_standard_set_button')}
          </Button>
          <HelpPopover className="shrink-0">{t('series_standard_set_help')}</HelpPopover>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges}
          loading={isSaving}
        >
          {t('series_save_button')}
        </Button>
      </div>
    </SettingsGroup>
  )
}
