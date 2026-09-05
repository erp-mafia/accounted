'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow, DefEmpty } from '@/components/ui/detail-section'
import { useToast } from '@/components/ui/use-toast'
import type { Dossier } from '@/lib/parties/register'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import { formatDate, formatOrgNumber } from '@/lib/utils'
import { registryFacts, registryLabel, registryValue } from './RegistryFacts'
import { ScbPickerDialog } from './ScbPickerDialog'
import { regionName } from './SuggestionQueue'

/**
 * "Företagsuppgifter" on a supplier or customer page: what the register
 * knows about the company behind the row. Legal name, org number and VAT
 * number first, then the facts SCB gave under one source line, and one
 * action: fetch by org number when there is one, find the company in the
 * register when there is not. The same facts the party dossier shows; this
 * is where people look for them.
 */
export function PartyFactsSection({
  partyId,
  canWrite,
  onChanged,
}: {
  partyId: string
  canWrite: boolean
  /** The party was enriched or renamed; the owning row may have changed too. */
  onChanged?: () => void
}) {
  const t = useTranslations('parties')
  const locale = useLocale()
  const { toast } = useToast()
  const [dossier, setDossier] = useState<Dossier | null>(null)
  const [scbEnabled, setScbEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/parties/${partyId}`)
      if (!res.ok) throw new Error(String(res.status))
      const json = (await res.json()) as { data: Dossier | null; scbConfigured?: boolean }
      setDossier(json.data)
      setScbEnabled(!!json.scbConfigured)
    } catch {
      setDossier(null)
    } finally {
      setLoaded(true)
    }
  }, [partyId])

  useEffect(() => {
    void load()
  }, [load])

  async function fetchRegistry(orgNumber?: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/parties/${partyId}/enrich`, {
        method: 'POST',
        headers: orgNumber ? { 'Content-Type': 'application/json' } : undefined,
        body: orgNumber ? JSON.stringify({ orgNumber }) : undefined,
      })
      const json = (await res.json()) as {
        data?: { found: boolean; orgNumber: string; inserted: number; superseded: number; refreshed: number; renamedTo?: string | null }
        error?: { details?: { reason?: string; displayName?: string } }
      }
      if (!res.ok || !json.data) {
        if (json.error?.details?.reason === 'org_number_taken') {
          toast({ title: t('picker_taken_title', { name: json.error.details.displayName ?? '' }), description: t('picker_taken_description') })
          return
        }
        toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
        return
      }
      setPicker(false)
      if (!json.data.found) {
        toast({ title: t('registry_not_found_title'), description: t('registry_not_found_description', { org: json.data.orgNumber }) })
        return
      }
      toast({
        title: json.data.renamedTo ? t('facts_renamed_title', { name: json.data.renamedTo }) : t('registry_fetched_title'),
        description: t('registry_fetched_description', { inserted: json.data.inserted, superseded: json.data.superseded, refreshed: json.data.refreshed }),
      })
      await load()
      onChanged?.()
    } catch {
      toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (!loaded || !dossier) return null
  const p = dossier.party
  const registry = registryFacts(dossier.facts)
  const fetchedAt = dossier.facts.find((f) => f.source === 'registry_scb')?.fetchedAt ?? null
  const registryVat = dossier.facts.find((f) => f.field === 'vat_number' && f.source === 'registry_scb')?.value
  const countryRaw = dossier.facts.find((f) => f.field === 'country')?.value
  const country = typeof countryRaw === 'string' && /^[A-Za-z]{2}$/.test(countryRaw) ? countryRaw.toUpperCase() : null
  const canFetch = scbEnabled && canWrite && isLegalPersonOrgNumber(p.orgNumber)
  const canFind = scbEnabled && canWrite && !p.orgNumber && p.kind !== 'person' && (!country || country === 'SE')

  return (
    <>
      <DetailSection
        kicker={t('facts_section_title')}
        aside={
          canFetch ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void fetchRegistry()} disabled={busy}>
              {busy ? t('fetching_registry') : registry.length > 0 ? t('facts_refresh') : t('fetch_registry')}
            </Button>
          ) : canFind ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setPicker(true)} disabled={busy}>
              {t('pick_registry')}
            </Button>
          ) : undefined
        }
      >
        <DefRow label={t('fact_legal_name')}>{p.legalName ?? <DefEmpty />}</DefRow>
        <DefRow label={t('fact_org')}>{p.orgNumber ? <span className="tabular-nums">{formatOrgNumber(p.orgNumber)}</span> : <DefEmpty />}</DefRow>
        <DefRow label={t('fact_vat')}>{p.vatNumber ?? (registryVat ? String(registryVat) : <DefEmpty />)}</DefRow>
        {country ? <DefRow label={t('fact_country')}>{regionName(country, locale)}</DefRow> : null}
        {registry.map((f) => (
          <DefRow key={f.id} label={f.field === 'postal_address' && !(f.value as { street?: string | null })?.street ? t('fact_postal_code_city') : registryLabel(t, f.field)}>
            {registryValue(f.value)}
          </DefRow>
        ))}
        <p className="pt-2 text-xs text-muted-foreground">
          {fetchedAt
            ? t('registry_group', { date: formatDate(fetchedAt) })
            : country && country !== 'SE'
              ? t('facts_foreign', { country: regionName(country, locale) })
              : p.orgNumber
                ? t('facts_none_org')
                : t('facts_none')}
        </p>
      </DetailSection>

      {picker ? (
        <ScbPickerDialog
          open
          onOpenChange={(open) => (!open ? setPicker(false) : undefined)}
          partyId={partyId}
          partyName={p.legalName ?? p.displayName}
          busy={busy}
          onPick={async (c: ScbCandidate) => {
            await fetchRegistry(c.orgNumber)
          }}
        />
      ) : null}
    </>
  )
}
