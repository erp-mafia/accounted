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
 * Rows are the union of the letters that have vouchers (voucher_sequences),
 * the letters configured as defaults, and the letters that already carry a
 * name, so a freshly assigned series (L for löner, no voucher yet) can be
 * named before its first verifikat. The name is display only: it is what the
 * pickers show next to the letter, with the Swedish preset as the fallback.
 * The letter itself stays the identifier on every journal entry.
 */
export function VoucherSeriesManager({ settings, onSettingsUpdated }: VoucherSeriesManagerProps) {
  const t = useTranslations('settings_voucher_series')
  const { company } = useCompany()
  const { toast } = useToast()
  const [series, setSeries] = useState<VoucherSeries[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)

  const savedLabels = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [letter, name] of Object.entries(settings.voucher_series_labels ?? {})) {
      if (SERIES_LETTER_RE.test(letter) && typeof name === 'string' && name.trim()) {
        out[letter] = name.trim()
      }
    }
    return out
  }, [settings.voucher_series_labels])
  const [draft, setDraft] = useState<Record<string, string>>(savedLabels)
  // Re-seed the draft when the saved names change underneath us (another
  // form on the page saved, or the settings were refetched).
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

  // Highest last_number per letter across fiscal periods.
  const lastNumbers = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const s of series) {
      if (!SERIES_LETTER_RE.test(s.voucher_series)) continue
      acc[s.voucher_series] = Math.max(acc[s.voucher_series] || 0, s.last_number)
    }
    return acc
  }, [series])

  const letters = useMemo(() => {
    const set = new Set<string>()
    const consider = (value: unknown) => {
      if (typeof value === 'string' && SERIES_LETTER_RE.test(value)) set.add(value)
    }
    Object.keys(lastNumbers).forEach(consider)
    consider(defaultSeries)
    Object.values(settings.default_voucher_series_per_source_type ?? {}).forEach(consider)
    Object.keys(savedLabels).forEach(consider)
    return Array.from(set).sort()
  }, [lastNumbers, defaultSeries, settings.default_voucher_series_per_source_type, savedLabels])

  // The map the API receives: every listed letter, empty string meaning
  // "clear this name" (the schema strips empties before storing).
  const hasChanges = letters.some((letter) => (draft[letter] ?? '').trim() !== (savedLabels[letter] ?? ''))

  const handleSave = async () => {
    setIsSaving(true)
    try {
      const payload: Record<string, string> = {}
      for (const letter of letters) payload[letter] = (draft[letter] ?? '').trim()
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
    <SettingsGroup label={t('heading')} help={t('name_help')}>
      {isLoading ? (
        <div className="space-y-2 px-1 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
      ) : letters.length === 0 ? (
        <p className="px-1 py-3 text-sm text-muted-foreground">
          {t('empty_state', { series: defaultSeries })}
        </p>
      ) : (
        <>
          {letters.map((letter, i) => {
            const lastNum = lastNumbers[letter]
            // Placeholder shows the preset the name would fall back to, so an
            // empty field never reads as "this series has no meaning".
            const preset = voucherSeriesLabel(letter)
            return (
              <SettingsRow
                key={letter}
                label={`${t('series_prefix')} ${letter}`}
                htmlFor={`series-name-${letter}`}
                borderless={i === letters.length - 1}
              >
                <SettingsInput
                  id={`series-name-${letter}`}
                  value={draft[letter] ?? ''}
                  maxLength={NAME_MAX_LENGTH}
                  placeholder={preset || t('name_placeholder')}
                  aria-label={`${t('name_column')} ${letter}`}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [letter]: e.target.value }))}
                  className="w-full md:w-64"
                />
                {letter === defaultSeries && (
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
