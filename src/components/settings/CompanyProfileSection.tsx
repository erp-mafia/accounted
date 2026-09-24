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

type Snapshot = Parameters<typeof CompanyProfileView>[0]['snapshot']

// Företagsprofil: the cached TIC company snapshot (Bolagsuppgifter), rendered
// as a read-only section on the Företag tab. Fetched client-side (low-traffic
// settings) so it sits alongside the client-rendered company form. RLS scopes
// the read to the user's own company. The trailing "Hämta" row lets the user
// (re)fetch live when the snapshot is missing or wrong: the recovery path for
// an enskild firma whose personnummer previously resolved to the wrong entity.
export function CompanyProfileSection() {
  const t = useTranslations('company_profile_section')
  const { company } = useCompany()
  const [snapshot, setSnapshot] = useState<Snapshot>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)
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
    if (result.ok) {
      setSnapshot((result.snapshot as Snapshot) ?? null)
      setFetchedAt(result.fetchedAt ?? null)
    } else {
      switch (result.error) {
        case 'org_number_invalid':
          setError(t('error_org_number_invalid'))
          break
        case 'not_found':
          setError(t('error_not_found'))
          break
        case 'unauthorized':
          setError(t('error_unauthorized'))
          break
        default:
          setError(t('error_persist_failed'))
      }
    }
    setSubmitting(false)
  }

  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />

  return (
    <SettingsGroup label={t('group_label')}>
      <CompanyProfileView snapshot={snapshot} />

      <SettingsRow
        label={snapshot ? t('update_label') : t('fetch_label')}
        help={t('help')}
        borderless
      >
        <form
          onSubmit={handleFetch}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1"
        >
          <SettingsInput
            id="tic_org_number"
            aria-label={t('org_number_aria')}
            value={orgInput}
            onChange={(e) => setOrgInput(e.target.value)}
            placeholder="XXXXXX-XXXX"
            inputMode="numeric"
            autoComplete="off"
            className="max-w-xs tabular-nums"
          />
          <Button type="submit" size="sm" disabled={!orgInput.trim()} loading={submitting}>
            {submitting ? t('fetching') : t('fetch')}
          </Button>
          {fetchedAt && (
            <SettingsRowNote>{t('updated_at', { date: formatDateLong(fetchedAt) })}</SettingsRowNote>
          )}
          {error && <span className="basis-full text-xs text-destructive">{error}</span>}
        </form>
      </SettingsRow>
    </SettingsGroup>
  )
}
