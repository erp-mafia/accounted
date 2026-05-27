'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Building2, ArrowRight, Loader2, Plus, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { switchCompany } from '@/lib/company/actions'
import { mapEntityType } from '@/lib/company-lookup/entity-type-map'
import type { EnrichmentCompanyRole } from '@/lib/company-lookup/types'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()

export interface MemberCompany {
  id: string
  name: string
  orgNumber: string | null
  entityType: string | null
  role: string
}

export interface TicPickerCompany {
  role: EnrichmentCompanyRole
  /** 'new' = not in gnubok, can set up. 'exists' = in gnubok but user is not a member. */
  status: 'new' | 'exists'
}

interface BankIdCompanyPickerProps {
  firstName: string | null
  teamId: string
  memberCompanies: MemberCompany[]
  ticCompanies: TicPickerCompany[]
  enrichmentStale: boolean
}

type SetupState =
  | { kind: 'idle' }
  | { kind: 'opening'; companyId: string }

// Swedish legal entity names (Aktiebolag, Enskild firma, etc.) are statutory
// terms — kept in Swedish in both locales.
function humanEntityType(t: string | null | undefined): string {
  if (!t) return ''
  if (t === 'aktiebolag') return 'Aktiebolag'
  if (t === 'enskild_firma') return 'Enskild firma'
  // TIC legalEntityType strings ('AB', 'HB', etc.) fall through to this
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
  teamId,
  memberCompanies,
  ticCompanies,
  enrichmentStale,
}: BankIdCompanyPickerProps) {
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('select_company')
  const [setup, setSetup] = useState<SetupState>({ kind: 'idle' })

  const hour = new Date().getHours()
  const greeting = hour < 5 ? t('greeting_night') : hour < 10 ? t('greeting_morning') : hour < 14 ? t('greeting_hello') : hour < 18 ? t('greeting_afternoon') : t('greeting_evening')

  const busy = setup.kind !== 'idle'

  async function handleOpenMember(companyId: string) {
    if (busy) return
    setSetup({ kind: 'opening', companyId })
    const result = await switchCompany(companyId)
    if (result.error) {
      toast({ title: result.error, variant: 'destructive' })
      setSetup({ kind: 'idle' })
      return
    }
    window.location.assign('/')
  }

  // BankID picker no longer one-click-provisions. Every pick routes to the
  // onboarding wizard with the orgnr (and entity_type via the server-side
  // CompanyRoles match in /onboarding) pre-filled. F-skatt / VAT / address
  // are confirmed by the user in Steps 2-4 instead of being auto-fetched
  // from TIC — costs us ~1 Lens call per signup but avoids any TIC budget
  // spend (companyRoles is on the Identity API, which is a separate quota).
  function handleCreateFromTic(role: EnrichmentCompanyRole) {
    if (busy) return
    const orgNumber = role.companyRegistrationNumber.replace(/[\s-]/g, '')
    router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
  }

  return (
    <div className="stagger-enter">
      <header className="mb-10">
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="text-muted-foreground text-sm mt-1.5">
          {t('subtitle')}
        </p>
      </header>

      <div className="max-w-lg space-y-8">
        {enrichmentStale && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                {t('enrichment_stale')}
              </p>
            </div>
          </div>
        )}

        {memberCompanies.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground mb-3">
              {t('section_your_companies', { appName: branding.appName.toLowerCase() })}
            </h2>
            <ul className="space-y-2">
              {memberCompanies.map((c) => {
                const isOpening = setup.kind === 'opening' && setup.companyId === c.id
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => handleOpenMember(c.id)}
                      disabled={busy}
                      className={cn(
                        'w-full rounded-lg border bg-card p-4 text-left transition-colors',
                        !busy && 'hover:border-foreground/30 hover:bg-muted/30',
                        busy && 'opacity-60 cursor-not-allowed',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{c.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {c.orgNumber ? `${c.orgNumber} · ` : ''}
                            {humanEntityType(c.entityType)}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {c.role !== 'owner' && (
                            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
                              {c.role}
                            </span>
                          )}
                          {isOpening
                            ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            : <ArrowRight className="h-4 w-4 text-muted-foreground" />}
                        </div>
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {ticCompanies.length > 0 && (
          <section>
            <h2 className="text-xs uppercase tracking-[0.08em] text-muted-foreground mb-3">
              {t('section_bankid_companies')}
            </h2>
            <ul className="space-y-2">
              {ticCompanies.map(({ role, status }) => {
                const cleaned = role.companyRegistrationNumber.replace(/[\s-]/g, '')
                const position = positionLabel(role)
                const entityLabel = humanTicEntityType(role.legalEntityType)
                const mappable = mapEntityType(role.legalEntityType) !== null

                if (status === 'exists') {
                  return (
                    <li key={cleaned}>
                      <div className="w-full rounded-lg border bg-muted/20 p-4 text-left opacity-70">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{role.legalName}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {cleaned} · {entityLabel}
                            </p>
                          </div>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
                            {t('already_in_app', { appName: branding.appName.toLowerCase() })}
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground/70 mt-2">
                          {t('ask_admin_invite')}
                        </p>
                      </div>
                    </li>
                  )
                }

                if (!mappable) {
                  return (
                    <li key={cleaned}>
                      <Link
                        href={`/onboarding?org_number=${encodeURIComponent(cleaned)}`}
                        className={cn(
                          'block w-full rounded-lg border bg-card p-4 text-left transition-colors',
                          !busy && 'hover:border-foreground/30 hover:bg-muted/30',
                          busy && 'pointer-events-none opacity-60',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate">{role.legalName}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">
                              {cleaned} · {entityLabel}
                              {position ? ` · ${position}` : ''}
                            </p>
                          </div>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground flex-shrink-0">
                            {t('setup_manually')}
                          </span>
                        </div>
                      </Link>
                    </li>
                  )
                }

                return (
                  <li key={cleaned}>
                    <button
                      type="button"
                      onClick={() => handleCreateFromTic(role)}
                      disabled={busy}
                      className={cn(
                        'w-full rounded-lg border bg-card p-4 text-left transition-colors',
                        !busy && 'hover:border-foreground/30 hover:bg-muted/30',
                        busy && 'opacity-60 cursor-not-allowed',
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-sm truncate">{role.legalName}</p>
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {cleaned} · {entityLabel}
                            {position ? ` · ${position}` : ''}
                          </p>
                        </div>
                        <ArrowRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {memberCompanies.length === 0 && ticCompanies.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('no_companies_found')}
          </p>
        )}

        <div className="relative">
          <div className="absolute inset-0 flex items-center" aria-hidden>
            <div className="w-full border-t border-border/60" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-3 text-xs uppercase tracking-[0.08em] text-muted-foreground">
              {t('or_separator')}
            </span>
          </div>
        </div>

        <Link
          href="/onboarding"
          className={cn(
            'flex items-center justify-center gap-2 w-full rounded-lg border border-dashed p-4 text-sm font-medium transition-colors',
            !busy && 'hover:border-foreground/30 hover:bg-muted/30',
            busy && 'pointer-events-none opacity-60',
          )}
        >
          <Plus className="h-4 w-4" />
          {t('add_company_manually')}
        </Link>
      </div>
    </div>
  )
}
