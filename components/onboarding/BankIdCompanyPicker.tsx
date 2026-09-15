'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { AttnLine } from '@/components/ui/attn-line'
import { mapEntityType, mapSetupEntityType } from '@/lib/company-lookup/entity-type-map'
import { ENTITY_TYPE_LABELS_SV } from '@/lib/company/entity-type'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import '@/components/onboarding/journey/journey.css'

/**
 * BankID company picker: the companies the user's BankID says they run
 * (CompanyRoles) that are not in Accounted yet, as the journey's searchable
 * list (founder decision 2026-07-24: the list is the standard at ANY count).
 * Picking one routes to /onboarding?org_number=… (one Lens lookup happens
 * there, on pick); "Lägg till manuellt" is the journey without a prefill.
 * The roster itself is free CompanyRoles data: this page never calls TIC.
 * Companies the user already belongs to are not listed: the page redirects
 * before rendering when there is nothing new to add (founder direction
 * 2026-09-14), and opening a company is the in-app switcher's job.
 */

interface BankIdCompanyPickerProps {
  firstName: string | null
  teamId: string
  /** Active engagements not yet in Accounted, in CompanyRoles order. */
  roles: EnrichmentCompanyRole[]
  enrichmentStale: boolean
  /** A pending invitation exists for this email but no invite token is at
   *  hand: point the user back to the link in the invitation email. */
  hasPendingInvite?: boolean
}

function humanTicEntityType(t: string): string {
  const mapped = mapEntityType(t)
  if (mapped) return ENTITY_TYPE_LABELS_SV[mapped]
  if (t.toLowerCase().includes('handelsbolag') || t.toLowerCase() === 'hb') return 'Handelsbolag'
  if (t.toLowerCase().includes('kommanditbolag') || t.toLowerCase() === 'kb') return 'Kommanditbolag'
  return t
}

function positionLabel(role: EnrichmentCompanyRole): string {
  const descs = role.positionDescriptions?.filter(Boolean)
  if (descs && descs.length > 0) return descs.join(' · ')
  const types = role.positionTypes?.filter(Boolean)
  if (types && types.length > 0) return types.join(' · ')
  return ''
}

export default function BankIdCompanyPicker({
  firstName,
  roles,
  enrichmentStale,
  hasPendingInvite = false,
}: BankIdCompanyPickerProps) {
  const router = useRouter()
  const t = useTranslations('select_company')
  const [query, setQuery] = useState('')

  const hour = new Date().getHours()
  const greeting = hour < 5 ? t('greeting_night') : hour < 10 ? t('greeting_morning') : hour < 14 ? t('greeting_hello') : hour < 18 ? t('greeting_afternoon') : t('greeting_evening')

  const q = query.trim().toLowerCase()
  const filtered = useMemo(
    () =>
      roles.filter(
        (role) =>
          !q ||
          role.legalName.toLowerCase().includes(q) ||
          role.companyRegistrationNumber.replace(/[\s-]/g, '').includes(q.replace(/[\s-]/g, '')),
      ),
    [roles, q],
  )

  // Every engagement pick routes to the journey with the orgnr; the journey
  // runs ONE Lens lookup on arrival and prefills facts (plan addendum
  // 2026-07-24). CompanyRoles itself is on the Identity API: separate quota.
  function handleCreateFromTic(role: EnrichmentCompanyRole) {
    const orgNumber = role.companyRegistrationNumber.replace(/[\s-]/g, '')
    router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
  }

  function onSearchEnter() {
    if (filtered.length === 1) handleCreateFromTic(filtered[0])
  }

  return (
    <div className="stagger-enter">
      <header className="mb-8 text-center">
        <h1 className="font-display text-2xl md:text-3xl tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="text-muted-foreground text-sm mt-1.5">{t('subtitle')}</p>
      </header>

      {hasPendingInvite && (
        <div className="mb-6 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm text-muted-foreground text-center">
            {t('pending_invite_note')}
          </p>
        </div>
      )}

      {enrichmentStale && (
        <AttnLine className="mb-6">{t('enrichment_stale')}</AttnLine>
      )}

      {roles.length > 1 && (
        <div className="jny-biginput jny-filter" style={{ margin: '0 auto' }}>
          <input
            value={query}
            placeholder={t('search_placeholder')}
            aria-label={t('search_placeholder')}
            autoComplete="off"
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearchEnter()}
          />
        </div>
      )}

      <div className="jny-rowlist" style={{ maxHeight: '52vh' }}>
        {filtered.map((role) => {
          const cleaned = role.companyRegistrationNumber.replace(/[\s-]/g, '')
          const position = positionLabel(role)
          const entityLabel = humanTicEntityType(role.legalEntityType)
          const mappable = mapSetupEntityType(role.legalEntityType) !== null
          const metaParts = [entityLabel, position].filter(Boolean)
          if (!mappable) metaParts.push(t('setup_manually'))
          return (
            <button
              key={cleaned}
              type="button"
              className="jny-rowpick"
              onClick={() => handleCreateFromTic(role)}
            >
              <span className="jny-rleft">
                <span className="jny-rname">{role.legalName}</span>
                <span className="jny-rmeta">{metaParts.join(' · ')}</span>
              </span>
              <span className="jny-rorg">{role.companyRegistrationNumber}</span>
            </button>
          )
        })}

        {filtered.length === 0 && (
          <div className="jny-rownote">{t('no_search_matches')}</div>
        )}
      </div>

      <div className="mt-6 text-center">
        <Link href="/onboarding" className="jny-btn-quiet" style={{ textDecoration: 'none' }}>
          {t('add_company_manually')} &hellip;
        </Link>
      </div>
    </div>
  )
}
