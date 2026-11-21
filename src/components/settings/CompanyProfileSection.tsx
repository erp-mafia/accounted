'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import { CompanyProfileView } from '@/components/settings/CompanyProfileView'
import { refreshCompanyProfileAction } from '@/lib/company/tic-refresh'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { formatDateLong } from '@/lib/utils'
import { useFormat } from '@/lib/hooks/use-format'

type Snapshot = Parameters<typeof CompanyProfileView>[0]['snapshot']

// The panel rows a failed detail call can leave empty (the snapshot's
// incompleteSections keys), each named once in the note under the panel.
const INCOMPLETE_SECTION_LABELS: ReadonlyArray<[keys: readonly string[], labelKey: string]> = [
  [['representatives', 'board'], 'profile_section_representatives'],
  [['statuses'], 'profile_section_status'],
  [['fiscalYear'], 'profile_section_fiscal_year'],
]

const ERROR_MESSAGES: Record<string, string> = {
  org_number_invalid: 'Ogiltigt organisations- eller personnummer.',
  not_found: 'Inga bolagsuppgifter hittades för det numret.',
  unauthorized: 'Du har inte behörighet att hämta uppgifter.',
  persist_failed: 'Något gick fel. Försök igen.',
}

// The org number rule's refusals (lib/company/org-number-rule.ts), translated.
const RULE_ERROR_KEYS: Record<string, string> = {
  org_number_locked: 'profile_error_org_number_locked',
  org_number_personnummer_required: 'profile_error_personnummer_required',
  org_number_legal_entity_required: 'profile_error_legal_entity_required',
}

// Företagsprofil: the cached TIC company snapshot (Bolagsuppgifter), rendered
// as a read-only section on the Företag tab. Fetched client-side (low-traffic
// settings) so it sits alongside the client-rendered company form. RLS scopes
// the read to the user's own company. The trailing "Hämta" row lets the user
// (re)fetch live when the snapshot is missing or wrong: the recovery path for
// an enskild firma whose personnummer previously resolved to the wrong entity.
export function CompanyProfileSection() {
  const { company } = useCompany()
  const t = useTranslations('settings_company')
  const { locale, formatDateLong: formatLocalDate } = useFormat()
  const [snapshot, setSnapshot] = useState<Snapshot>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
  const [resumesOn, setResumesOn] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [orgInput, setOrgInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!company?.id) return
    const supabase = createClient()
    let cancelled = false
    supabase
      .from('companies')
      .select('tic_snapshot, tic_snapshot_fetched_at, org_number')
      .eq('id', company.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        setSnapshot((data?.tic_snapshot as Snapshot) ?? null)
        setFetchedAt((data?.tic_snapshot_fetched_at as string | null) ?? null)
        setOrgInput((data?.org_number as string | null) ?? '')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [company?.id])

  async function handleFetch(e: React.FormEvent) {
    e.preventDefault()
    if (!company?.id || submitting) return
    setSubmitting(true)
    setError(null)
    const result = await refreshCompanyProfileAction(company.id, orgInput)
    setResumesOn(result.resumesOn ?? null)
    if (result.ok) {
      setSnapshot((result.snapshot as Snapshot) ?? null)
      setFetchedAt(result.fetchedAt ?? null)
    } else {
      const code = result.error ?? ''
      setError(
        code === 'paused' && result.resumesOn
          ? t('profile_error_paused', { date: formatLocalDate(result.resumesOn) })
          : code === 'unavailable'
            ? t('profile_error_unavailable')
            : RULE_ERROR_KEYS[code]
              ? t(RULE_ERROR_KEYS[code])
              : (ERROR_MESSAGES[code] ?? ERROR_MESSAGES.persist_failed),
      )
    }
    setSubmitting(false)
  }

  // Rows Bolagsverket could not fill on the last fetch: they show as missing,
  // not as "nothing registered".
  const missing = snapshot?.incompleteSections ?? []
  const missingLabels = INCOMPLETE_SECTION_LABELS
    .filter(([keys]) => keys.some((key) => missing.includes(key)))
    .map(([, labelKey]) => t(labelKey))
  const missingList = new Intl.ListFormat(locale === 'en' ? 'en' : 'sv', { type: 'conjunction' }).format(missingLabels)
  const missingSections = missingList.charAt(0).toLocaleUpperCase(locale) + missingList.slice(1)

  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />

  return (
    <SettingsGroup label="Bolagsuppgifter">
      <CompanyProfileView snapshot={snapshot} />

      {missingLabels.length > 0 && (
        <p className="border-b-hairline px-1 py-3 text-sm text-muted-foreground">
          {resumesOn
            ? t('profile_incomplete_paused', { sections: missingSections, date: formatLocalDate(resumesOn) })
            : t('profile_incomplete', { sections: missingSections })}
        </p>
      )}

      <SettingsRow
        label={snapshot ? 'Uppdatera bolagsuppgifter' : 'Hämta bolagsuppgifter'}
        help="Uppgifterna hämtas från Bolagsverket. För enskild firma anges personnumret."
        borderless
      >
        <form
          onSubmit={handleFetch}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1"
        >
          <SettingsInput
            id="tic_org_number"
            aria-label="Organisationsnummer eller personnummer"
            value={orgInput}
            onChange={(e) => setOrgInput(e.target.value)}
            placeholder="XXXXXX-XXXX"
            inputMode="numeric"
            autoComplete="off"
            className="max-w-xs tabular-nums"
          />
          <Button type="submit" disabled={!orgInput.trim()} loading={submitting}>
            {submitting ? 'Hämtar…' : 'Hämta'}
          </Button>
          {fetchedAt && (
            <SettingsRowNote>Uppdaterad {formatDateLong(fetchedAt)}</SettingsRowNote>
          )}
          {error && <span className="basis-full text-xs text-destructive">{error}</span>}
        </form>
      </SettingsRow>
    </SettingsGroup>
  )
}
