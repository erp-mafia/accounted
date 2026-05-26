'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { Building2, ArrowRight, Loader2, Plus, Check, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { switchCompany, createCompanyFromTicRole } from '@/lib/company/actions'
import { mapEntityType } from '@/lib/company-lookup/entity-type-map'
import type { CompanyLookupResult, EnrichmentCompanyRole } from '@/lib/company-lookup/types'
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
  | { kind: 'creating'; orgNumber: string; step: 'lookup' | 'provision' }

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
  const [isPending, startTransition] = useTransition()

  const hour = new Date().getHours()
  const greeting = hour < 5 ? t('greeting_night') : hour < 10 ? t('greeting_morning') : hour < 14 ? t('greeting_hello') : hour < 18 ? t('greeting_afternoon') : t('greeting_evening')

  const busy = setup.kind !== 'idle' || isPending

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

  async function handleCreateFromTic(role: EnrichmentCompanyRole) {
    if (busy) return
    const orgNumber = role.companyRegistrationNumber.replace(/[\s-]/g, '')
    const mapped = mapEntityType(role.legalEntityType)
    if (!mapped) {
      // Entity type isn't supported end-to-end — route to manual wizard with
      // the org number pre-filled.
      router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
      return
    }

    setSetup({ kind: 'creating', orgNumber, step: 'lookup' })

    let lookup: CompanyLookupResult | null = null
    try {
      const res = await fetch(
        `/api/extensions/ext/tic/lookup?org_number=${encodeURIComponent(orgNumber)}`,
        { method: 'GET' },
      )
      if (res.ok) {
        const json = await res.json()
        lookup = (json?.data as CompanyLookupResult | undefined) ?? null
      }
    } catch {
      // Network/parse failure — fall through to the lookup-missing branch below.
    }

    // Without a lookup we don't know the company's VAT/F-skatt status.
    // Defaulting those to false for a momsregistrerat bolag would silently
    // create a company that issues invoices without moms — ML 17 kap violation.
    // Route to the manual wizard with the known fields pre-filled instead.
    if (!lookup) {
      toast({
        title: t('toast_lookup_failed_title'),
        description: t('toast_lookup_failed_description'),
      })
      setSetup({ kind: 'idle' })
      router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
      return
    }

    // Block provisioning for companies that are avregistrerade/likviderade.
    // Under BFL 2 kap, bokföringsskyldighet ends when a company is struck off.
    if (lookup.isCeased) {
      toast({
        title: t('toast_company_ceased_title'),
        description: t('toast_company_ceased_description'),
        variant: 'destructive',
      })
      setSetup({ kind: 'idle' })
      return
    }

    setSetup({ kind: 'creating', orgNumber, step: 'provision' })

    startTransition(async () => {
      const result = await createCompanyFromTicRole({
        teamId,
        orgNumber,
        legalName: role.legalName,
        legalEntityType: role.legalEntityType,
        lookup,
      })

      if (result.error === 'lookup_missing') {
        // Extremely unlikely (we just verified lookup above) but if it happens,
        // the same fallback applies.
        setSetup({ kind: 'idle' })
        router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
        return
      }

      if (result.error === 'org_number_exists') {
        toast({
          title: t('toast_company_exists_title'),
          description: t('toast_company_exists_description'),
          variant: 'destructive',
        })
        setSetup({ kind: 'idle' })
        return
      }

      if (result.error === 'company_ceased') {
        // Belt-and-suspenders: we already check lookup.isCeased client-side
        // above, but the server-side guard catches any race where TIC's
        // cached result differs between the two calls.
        toast({
          title: t('toast_company_ceased_title'),
          description: t('toast_company_ceased_description'),
          variant: 'destructive',
        })
        setSetup({ kind: 'idle' })
        return
      }

      if (result.error === 'org_number_invalid') {
        toast({
          title: t('toast_org_invalid_title'),
          description: t('toast_org_invalid_description'),
          variant: 'destructive',
        })
        setSetup({ kind: 'idle' })
        router.push(`/onboarding?org_number=${encodeURIComponent(orgNumber)}`)
        return
      }

      if (result.error || !result.companyId) {
        toast({
          title: t('toast_create_failed_title'),
          description: result.error ?? t('toast_create_failed_description'),
          variant: 'destructive',
        })
        setSetup({ kind: 'idle' })
        return
      }

      toast({ title: t('toast_welcome_title'), description: t('toast_company_ready') })
      window.location.assign('/')
    })
  }

  // Progress card while creating
  if (setup.kind === 'creating') {
    const lookupDone = setup.step === 'provision'
    return (
      <div className="stagger-enter">
        <header className="mb-10">
          <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
            {greeting}{firstName ? `, ${firstName}` : ''}
          </h1>
          <p className="text-muted-foreground text-sm mt-1.5">{t('setting_up')}</p>
        </header>

        <div className="max-w-lg rounded-xl border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          <div className="flex items-start gap-3">
            <Building2 className="h-5 w-5 text-muted-foreground mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-sm">{t('org_nr_prefix', { orgNumber: setup.orgNumber })}</p>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex items-center gap-2">
                  {lookupDone
                    ? <Check className="h-4 w-4 text-sage" />
                    : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                  <span className={cn(!lookupDone && 'text-muted-foreground')}>
                    {t('progress_lookup')}
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  {lookupDone
                    ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    : <span className="h-4 w-4 inline-block rounded-full border border-border" />}
                  <span className={cn(!lookupDone && 'text-muted-foreground/50')}>
                    {t('progress_provision')}
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    )
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
