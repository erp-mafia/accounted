'use client'

import { useTranslations } from 'next-intl'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { voucherSeriesLabel } from '@/lib/bookkeeping/voucher-series-resolver'
import type { CompanySettings } from '@/types'

interface VoucherSeries {
  voucher_series: string
  last_number: number
  fiscal_period_id: string
}

interface VoucherSeriesManagerProps {
  settings: Pick<
    CompanySettings,
    'default_voucher_series' | 'default_voucher_series_per_source_type' | 'voucher_series_labels'
  >
  onSettingsUpdated: (settings: Partial<CompanySettings>) => void
}

const SERIES_LETTER_RE = /^[A-Z]$/
const NAME_MAX_LENGTH = 40

/**
 * The series this company uses, with a name per letter.
 *
 * Rows are the union of every series that has vouchers (voucher_sequences,
 * including multi-character series such as FT or SKV carried over from a
 * Fortnox or Bokio import), the letters configured as defaults, and the
 * letters that already carry a name, so a freshly assigned series (L for
 * löner, no voucher yet) can be named before its first verifikat.
 *
 * Only single-letter series can be named: those are the ones the pickers
 * offer and the settings schema accepts. Imported multi-character series are
 * listed with their highest number, as before, and cannot be picked for new
 * vouchers anyway. The name is display only: it is what the pickers show
 * next to the letter, with the Swedish preset as the fallback. The letter
 * itself stays the identifier on every journal entry.
 */
export function VoucherSeriesManager({ settings, onSettingsUpdated }: VoucherSeriesManagerProps) {
  const t = useTranslations('settings_voucher_series')
  const { company } = useCompany()
  const { toast } = useToast()
  const [series, setSeries] = useState<VoucherSeries[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  // The saved names, keyed by CONTENT rather than object identity. The
  // settings hook revalidates on window focus and hands out a fresh object
  // even when nothing changed; re-seeding the draft on that identity change
  // would wipe whatever the user is typing. Serializing the filtered entries
  // gives a key that only changes when a name actually changes.
  const savedKey = useMemo(() => {
    const entries: Array<[string, string]> = []
    for (const [letter, name] of Object.entries(settings.voucher_series_labels ?? {})) {
      if (SERIES_LETTER_RE.test(letter) && typeof name === 'string' && name.trim()) {
        entries.push([letter, name.trim()])
      }
    }
    entries.sort(([a], [b]) => a.localeCompare(b))
    return JSON.stringify(entries)
  }, [settings.voucher_series_labels])
  const savedLabels = useMemo<Record<string, string>>(
    () => Object.fromEntries(JSON.parse(savedKey) as Array<[string, string]>),
    [savedKey],
  )
  const [draft, setDraft] = useState<Record<string, string>>(savedLabels)
  // Re-seed only when a saved name actually changed (another form on the
  // page saved, or the settings were refetched with different content).
  useEffect(() => { setDraft(savedLabels) }, [savedLabels])

  const defaultSeries = settings.default_voucher_series || 'A'

  const fetchSeries = useCallback(async () => {
    if (!company?.id) { setIsLoading(false); return }
    const supabase = createClient()
    const { data } = await supabase
      .from('voucher_sequences')
      .select('voucher_series, last_number, fiscal_period_id')
      .eq('company_id', company.id)
      .order('voucher_series')
    setSeries(data || [])
    setIsLoading(false)
  }, [company?.id])

  useEffect(() => { fetchSeries() }, [fetchSeries])

  // Highest last_number per series across fiscal periods. Every series the
  // ledger holds counts, whatever its shape: the number is the only place in
  // the UI that shows how far an imported series has run.
  const lastNumbers = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const s of series) {
      const key = s.voucher_series?.trim()
      if (!key) continue
      acc[key] = Math.max(acc[key] || 0, s.last_number)
    }
    return acc
  }, [series])

  const rows = useMemo(() => {
    const set = new Set<string>(Object.keys(lastNumbers))
    const considerLetter = (value: unknown) => {
      if (typeof value === 'string' && SERIES_LETTER_RE.test(value)) set.add(value)
    }
    considerLetter(defaultSeries)
    Object.values(settings.default_voucher_series_per_source_type ?? {}).forEach(considerLetter)
    Object.keys(savedLabels).forEach(considerLetter)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [lastNumbers, defaultSeries, settings.default_voucher_series_per_source_type, savedLabels])

  const nameableLetters = useMemo(() => rows.filter((s) => SERIES_LETTER_RE.test(s)), [rows])

  const hasChanges = nameableLetters.some(
    (letter) => (draft[letter] ?? '').trim() !== (savedLabels[letter] ?? ''),
  )

  const handleSave = async () => {
    setIsSaving(true)
    try {
      // Every nameable letter is sent, empty string meaning "clear this
      // name"; the schema strips empties before storing.
      const payload: Record<string, string> = {}
      for (const letter of nameableLetters) payload[letter] = (draft[letter] ?? '').trim()
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voucher_series_labels: payload }),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: t('per_account_save_failed'),
          description: getErrorMessage(json, { context: 'settings', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      const stored: Record<string, string> = {}
      for (const [letter, name] of Object.entries(payload)) if (name) stored[letter] = name
      onSettingsUpdated({ voucher_series_labels: stored })
      toast({ title: t('names_saved_title'), description: t('names_saved_description') })
    } catch (err) {
      toast({
        title: t('per_account_save_failed'),
        description: getErrorMessage(err, { context: 'settings' }),
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <SettingsGroup label={t('heading')} help={`${t('name_help')} ${t('footnote')}`}>
      {isLoading ? (
        <div className="space-y-2 px-1 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      ) : (
        <>
          {rows.map((seriesKey, i) => {
            const lastNum = lastNumbers[seriesKey]
            const nameable = SERIES_LETTER_RE.test(seriesKey)
            // Placeholder shows the preset the name would fall back to, so an
            // empty field never reads as "this series has no meaning".
            const preset = nameable ? voucherSeriesLabel(seriesKey) : ''
            return (
              <SettingsRow
                key={seriesKey}
                label={`${t('series_prefix')} ${seriesKey}`}
                htmlFor={nameable ? `series-name-${seriesKey}` : undefined}
                borderless={i === rows.length - 1}
              >
                {nameable && (
                  <SettingsInput
                    id={`series-name-${seriesKey}`}
                    value={draft[seriesKey] ?? ''}
                    maxLength={NAME_MAX_LENGTH}
                    placeholder={preset || t('name_placeholder')}
                    aria-label={`${t('name_column')} ${seriesKey}`}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [seriesKey]: e.target.value }))}
                    className="w-full md:w-64"
                  />
                )}
                {seriesKey === defaultSeries && (
                  <SettingsRowNote>{t('default_badge')}</SettingsRowNote>
                )}
                <span className="ml-auto shrink-0 text-sm text-muted-foreground tabular-nums">
                  {lastNum != null ? `${t('latest_number')}: ${lastNum}` : t('no_vouchers_yet')}
                </span>
              </SettingsRow>
            )
          })}
          <div className="flex justify-end px-1 pt-4">
            <Button type="button" size="sm" onClick={handleSave} disabled={!hasChanges || isSaving}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('save_names')}
            </Button>
          </div>
        </>
      )}
    </SettingsGroup>
  )
}
