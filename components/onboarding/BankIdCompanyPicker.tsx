'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { switchCompany } from '@/lib/company/actions'
import { mapEntityType } from '@/lib/company-lookup/entity-type-map'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import { getBranding } from '@/lib/branding/service'
import '@/components/onboarding/journey/journey.css'

const branding = getBranding()

/**
 * BankID company picker, restyled to the journey's searchable list
 * (founder decision 2026-07-24: the list is the standard at ANY count).
 * The contract is unchanged: picking a CompanyRoles engagement routes to
 * /onboarding?org_number=… (one Lens lookup happens there, on pick);
 * member companies switch + open directly. The roster itself is free
 * CompanyRoles data: this page never calls TIC.
 */

export interface MemberCompany {
  id: string
  name: string
  orgNumber: string | null
  entityType: string | null
  role: string
}

export interface TicPickerCompany {
  role: EnrichmentCompanyRole
  /** 'new' = not in Accounted, can set up. 'exists' = in Accounted but user is not a member. */
  status: 'new' | 'exists'
}

interface BankIdCompanyPickerProps {
  firstName: string | null
  teamId: string
  memberCompanies: MemberCompany[]
  ticCompanies: TicPickerCompany[]
  enrichmentStale: boolean
  /** A pending invitation exists for this email but no invite token is at
   *  hand: point the user back to the link in the invitation email. */
  hasPendingInvite?: boolean
}

type SetupState = { kind: 'idle' } | { kind: 'opening'; companyId: string }

// Swedish legal entity names (Aktiebolag, Enskild firma, etc.) are statutory
// terms: kept in Swedish in both locales.
function humanEntityType(t: string | null | undefined): string {
  if (!t) return ''
  if (t === 'aktiebolag') return 'Aktiebolag'
  if (t === 'enskild_firma') return 'Enskild firma'
  return t
}

function humanTicEntityType(t: string): string {
  const mapped = mapEntityType(t)
  if (mapped === 'aktiebolag') return 'Aktiebolag'
  if (mapped === 'enskild_firma') return 'Enskild firma'
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
  memberCompanies,
  ticCompanies,
  enrichmentStale,
  hasPendingInvite = false,
}: BankIdCompanyPickerProps) {
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('select_company')
  const [setup, setSetup] = useState<SetupState>({ kind: 'idle' })
  const [query, setQuery] = useState('')

  const hour = new Date().getHours()
  const greeting = hour < 5 ? t('greeting_night') : hour < 10 ? t('greeting_morning') : hour < 14 ? t('greeting_hello') : hour < 18 ? t('greeting_afternoon') : t('greeting_evening')

  const busy = setup.kind !== 'idle'

  const q = query.trim().toLowerCase()
  const filteredTic = useMemo(
    () =>
      ticCompanies.filter(
        ({ role }) =>
          !q ||
          role.legalName.toLowerCase().includes(q) ||
          role.companyRegistrationNumber.replace(/[\s-]/g, '').includes(q.replace(/[\s-]/g, '')),
      ),
    [ticCompanies, q],
  )
  const filteredMembers = useMemo(
    () =>
      memberCompanies.filter(
        (c) =>
          !q ||
          c.name.toLowerCase().includes(q) ||
          (c.orgNumber ?? '').replace(/[\s-]/g, '').includes(q.replace(/[\s-]/g, '')),
      ),
    [memberCompanies, q],
  )

  async function handleOpenMember(companyId: string) {
    if (busy) return
    setSetup({ kind: 'opening', companyId })
    const result = await switchCompany(companyId)
    if (result.error) {
      toast({
        title: t(result.error === 'not_member' ? 'error_no_access' : 'error_switch_failed'),
        variant: 'destructive',
      })
      setSetup({ kind: 'idle' })
      return
    }
    window.location.assign('/')
  }

  // Every engagement pick routes to the journey with the orgnr; the journey
  // runs ONE Lens lookup on arrival and prefills facts (plan addendum
  // 2026-07-24). CompanyRoles itself is on the Identity API: separate quota.
  function handleCreateFromTic(role: EnrichmentCompanyRole) {
    if (busy) return
    const orgNumber = role.companyRegistrationNumber.replace(/[\s-]/g, '')
    router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
  }

  function onSearchEnter() {
    if (filteredTic.length === 1) handleCreateFromTic(filteredTic[0].role)
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

      <div className="jny-rowlist" style={{ maxHeight: '52vh' }}>
        {filteredTic.map(({ role, status }) => {
          const cleaned = role.companyRegistrationNumber.replace(/[\s-]/g, '')
          const position = positionLabel(role)
          const entityLabel = humanTicEntityType(role.legalEntityType)
          const mappable = mapEntityType(role.legalEntityType) !== null
          const metaParts = [entityLabel, position].filter(Boolean)
          if (!mappable) metaParts.push(t('setup_manually'))
          if (status === 'exists') {
            metaParts.push(t('already_in_app', { appName: branding.appName.toLowerCase() }))
          }
          return (
            <button
              key={cleaned}
              type="button"
              className="jny-rowpick"
              disabled={busy}
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

        {filteredMembers.length > 0 && (
          <div className="jny-rowsec">
            {t('section_your_companies', { appName: branding.appName.toLowerCase() })}
          </div>
        )}
        {filteredMembers.map((c) => {
          const isOpening = setup.kind === 'opening' && setup.companyId === c.id
          return (
            <button
              key={c.id}
              type="button"
              className="jny-rowpick is-existing"
              disabled={busy}
              onClick={() => handleOpenMember(c.id)}
            >
              <span className="jny-rleft">
                <span className="jny-rname">{c.name}</span>
                <span className="jny-rmeta">
                  {[humanEntityType(c.entityType), c.role !== 'owner' ? c.role : '']
                    .filter(Boolean)
                    .join(' · ') || t('opens_directly')}
                </span>
              </span>
              <span className="jny-rorg">
                {isOpening ? <Loader2 className="h-4 w-4 animate-spin" /> : c.orgNumber ?? ''}
              </span>
            </button>
          )
        })}

        {filteredTic.length === 0 && filteredMembers.length === 0 && (
          <div className="jny-rownote">
            {ticCompanies.length + memberCompanies.length === 0
              ? t('no_companies_found')
              : t('no_search_matches')}
          </div>
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
