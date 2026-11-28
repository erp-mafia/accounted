'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { SettingsRow, SettingsRowNote, SettingsSelect } from '@/components/settings/SettingsRows'
import { useStoredPreference, type StoredPreferences } from '@/components/settings/use-stored-preference'
import { useBookingScreenEnabled, useCompanyOptional } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import {
  START_PAGES,
  startPageFor,
  startPageOpens,
  storedStartPages,
} from '@/lib/company/start-page'

const pickStartPages = (data: StoredPreferences) => storedStartPages(data?.start_page)

// Startsida, a row of Ditt konto (/settings/account): the page this person
// lands on in the ACTIVE company after signing in or switching to it
// (lib/company/start-page.ts). Chosen per company, so the row names the
// company it applies to. Only the pages the person can open there are
// offered; a stored choice they can no longer open shows as Att göra, which
// is where they land. Read from GET /api/user/preferences, written through
// POST /api/user/ui-state.
export function StartPageRow() {
  const t = useTranslations('settings')
  const tNav = useTranslations('nav')
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const companyContext = useCompanyOptional()
  const company = companyContext?.company ?? null
  const bookingScreenEnabled = useBookingScreenEnabled()
  const ctx = { role: companyContext?.role ?? null, bookingScreenEnabled }
  const [saving, setSaving] = useState(false)
  // Unknown (null) until read; a failed read shows no choice rather than
  // claiming Att göra when another page is stored (use-stored-preference.ts).
  const { value: choices, setValue: setChoices, loadError, retry } = useStoredPreference(pickStartPages)

  if (!company) return null

  const current = choices === null ? null : startPageFor(choices, company.id, ctx).id
  const options = START_PAGES.filter((page) => startPageOpens(page.id, ctx))

  async function handleChange(next: string) {
    const page = options.find((p) => p.id === next)
    // Compared with what is stored, not with what is shown: a stored page the
    // person cannot open shows as Att göra, and choosing Att göra must still
    // replace it, or the old page returns when access does.
    const stored = choices?.[company?.id ?? '']
    if (!company || !page || choices === null || page.id === (stored ?? current)) return
    const previous = choices
    setChoices({ ...choices, [company.id]: page.id })
    setSaving(true)
    try {
      const res = await fetch('/api/user/ui-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_page: { [company.id]: page.id } }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setChoices(previous)
        toast({
          title: t('start_page_save_failed'),
          description: getErrorMessage(body, { statusCode: res.status, locale: errorLocale }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('start_page_saved') })
    } catch (err) {
      setChoices(previous)
      toast({
        title: t('start_page_save_failed'),
        description: getErrorMessage(err, { locale: errorLocale }),
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsRow label={t('start_page_label')} htmlFor="start_page" help={t('start_page_description')}>
      <SettingsSelect
        id="start_page"
        value={current ?? ''}
        onChange={(e) => void handleChange(e.target.value)}
        disabled={current === null || saving}
      >
        {options.map((page) => (
          <option key={page.id} value={page.id}>
            {tNav(page.labelKey)}
          </option>
        ))}
      </SettingsSelect>
      <div className="min-w-0 basis-full">
        {/* Live region always mounted so the failure is announced when it
            appears, not merely inserted. */}
        <div role="status" aria-live="polite">
          {loadError && (
            <AttnLine
              action={
                loadError.detail
                  ? undefined
                  : { label: t('start_page_load_retry'), onClick: retry }
              }
            >
              {loadError.detail ? `${t('start_page_load_failed')} ${loadError.detail}` : t('start_page_load_failed')}
            </AttnLine>
          )}
        </div>
        <SettingsRowNote>
          <span data-ph-mask="">{t('start_page_company', { company: company.name })}</span>
        </SettingsRowNote>
      </div>
    </SettingsRow>
  )
}
