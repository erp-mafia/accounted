'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { DetailSection, DefRow } from '@/components/ui/detail-section'
import { useToast } from '@/components/ui/use-toast'
import type { Dossier } from '@/lib/parties/register'
import type { RegistrySummary } from '@/lib/parties/registry-summary'
import { sameName } from '@/lib/parties/registry-name'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import type { ScbCandidate } from '@/lib/parties/scb/client'
import { formatDate } from '@/lib/utils'
import { ScbPickerDialog } from './ScbPickerDialog'
import { regionName } from './SuggestionQueue'

/**
 * "Företagsuppgifter" on a supplier or customer page: what only the register
 * knows, in a few lines. Identity (org number, VAT number) lives in the
 * page header and the contact section, and contact details the register
 * gave land on the row itself, so this block does not repeat them. It
 * carries the status line (legal form, active or not, registrations, and a
 * Bolagsverket warning when there is one), industry, seat, size, and one
 * action: fetch by org number, or find the company in the register.
 */
export function PartyFactsSection({
  partyId,
  rowName,
  canWrite,
  dossier,
  registry,
  scbEnabled,
  onChanged,
}: {
  partyId: string
  /** The supplier's or customer's own name, so the legal name shows only when it differs. */
  rowName: string
  canWrite: boolean
  dossier: Dossier
  registry: RegistrySummary | null
  scbEnabled: boolean
  /** The party was fetched, renamed or filled in; the owning row may have changed too. */
  onChanged: () => Promise<void> | void
}) {
  const t = useTranslations('parties')
  const locale = useLocale()
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState(false)

  async function fetchRegistry(orgNumber?: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/parties/${partyId}/enrich`, {
        method: 'POST',
        headers: orgNumber ? { 'Content-Type': 'application/json' } : undefined,
        body: orgNumber ? JSON.stringify({ orgNumber }) : undefined,
      })
      const json = (await res.json()) as {
        data?: { found: boolean; orgNumber: string; inserted: number; superseded: number; refreshed: number; renamedTo?: string | null; filled?: Record<string, string[]> }
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
      const filledFields = [...new Set(Object.values(json.data.filled ?? {}).flat())]
      const filledText = filledFields.length
        ? t('facts_filled_description', { fields: filledFields.map((f) => fieldLabel(t, f)).join(', ') })
        : t('registry_fetched_description', { inserted: json.data.inserted, superseded: json.data.superseded, refreshed: json.data.refreshed })
      toast({
        title: json.data.renamedTo ? t('facts_renamed_title', { name: json.data.renamedTo }) : filledFields.length ? t('facts_filled_title') : t('registry_fetched_title'),
        description: filledText,
      })
      await onChanged()
    } catch {
      toast({ title: t('registry_unavailable_title'), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const p = dossier.party
  const country = p.country
  const foreign = !!country && country !== 'SE'
  const canFetch = scbEnabled && canWrite && isLegalPersonOrgNumber(p.orgNumber)
  const canFind = scbEnabled && canWrite && !p.orgNumber && p.kind !== 'person' && !foreign
  const legalDiffers = !!p.legalName && !sameName(p.legalName, rowName)
  const registrations = registry
    ? (
        [
          [registry.registrations.f_tax, t('facts_reg_f_tax')],
          [registry.registrations.vat, t('facts_reg_vat')],
          [registry.registrations.employer, t('facts_reg_employer')],
        ] as const
      )
        .filter(([on]) => on === true)
        .map(([, label]) => label)
    : []
  const statusLine = registry
    ? [registry.legal_form, registry.status?.label].filter(Boolean).join(' · ')
    : null
  const attention = !!registry && (registry.warning !== null || registry.status?.active === false)

  return (
    <>
      <DetailSection
        kicker={t('facts_section_title')}
        aside={
          canFetch ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void fetchRegistry()} disabled={busy}>
              {busy ? t('fetching_registry') : registry ? t('facts_refresh') : t('fetch_registry')}
            </Button>
          ) : canFind ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setPicker(true)} disabled={busy}>
              {t('pick_registry')}
            </Button>
          ) : undefined
        }
      >
        {legalDiffers ? <DefRow label={t('fact_legal_name')}>{p.legalName}</DefRow> : null}
        {country && (foreign || !registry) ? <DefRow label={t('fact_country')}>{regionName(country, locale)}</DefRow> : null}
        {registry ? (
          <>
            <DefRow label={t('facts_status')}>
              <span className={attention ? 'text-warning' : undefined}>
                {registry.warning ? [statusLine, registry.warning].filter(Boolean).join(' · ') : statusLine}
              </span>
              {registrations.length > 0 ? (
                <span className="block text-xs text-muted-foreground">{t('facts_registered_for', { items: registrations.join(', ') })}</span>
              ) : registry.registrations.f_tax === false && registry.registrations.vat === false ? (
                <span className="block text-xs text-warning">{t('facts_not_registered')}</span>
              ) : null}
            </DefRow>
            {registry.industry ? <DefRow label={t('facts_industry')}>{registry.industry.label}</DefRow> : null}
            {registry.seat || registry.registered_at ? (
              <DefRow label={t('facts_seat')}>
                {registry.seat && registry.registered_at
                  ? t('facts_seat_registered', { seat: registry.seat, date: formatDate(registry.registered_at) })
                  : (registry.seat ?? formatDate(registry.registered_at as string))}
              </DefRow>
            ) : null}
            {registry.employees_band || registry.turnover || registry.workplaces ? (
              <DefRow label={t('facts_size')}>
                {[
                  registry.employees_band,
                  registry.turnover ? (registry.turnover.year ? `${registry.turnover.band} (${registry.turnover.year})` : registry.turnover.band) : null,
                  registry.workplaces && registry.workplaces > 1 ? t('facts_workplaces', { count: registry.workplaces }) : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </DefRow>
            ) : null}
          </>
        ) : null}
        <p className="pt-2 text-xs text-muted-foreground">
          {registry?.fetched_at
            ? t('registry_group', { date: formatDate(registry.fetched_at) })
            : foreign
              ? t('facts_foreign', { country: regionName(country as string, locale) })
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

function fieldLabel(t: (k: string) => string, field: string): string {
  switch (field) {
    case 'email':
      return t('fact_email')
    case 'phone':
      return t('fact_phone')
    case 'address_line1':
    case 'address_line2':
    case 'postal_code':
    case 'city':
      return t('fact_postal_address')
    default:
      return field
  }
}
