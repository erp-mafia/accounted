'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { createCompanyFromOnboarding } from '@/lib/company/actions'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import type { CompanySettings, EntityType, MomsPeriod } from '@/types'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()

import Step1EntityType from '@/components/onboarding/Step1EntityType'
import Step2CompanyDetails from '@/components/onboarding/Step2CompanyDetails'
import Step3TaxRegistration from '@/components/onboarding/Step3TaxRegistration'
import Step4VatAccounting from '@/components/onboarding/Step4VatAccounting'

type TFn = (key: string, values?: Record<string, string | number>) => string

function buildStepInfo(t: TFn) {
  return [
    { title: t('step1_title'), subtitle: t('step1_subtitle'), label: t('step1_label') },
    { title: t('step2_title'), subtitle: t('step2_subtitle'), label: t('step2_label') },
    { title: t('step3_title'), subtitle: t('step3_subtitle'), label: t('step3_label') },
    { title: t('step4_title'), subtitle: t('step4_subtitle'), label: t('step4_label') },
  ]
}

function translatePeriodError(msg: string, t: TFn): string {
  if (msg.includes('end must be after')) return t('period_error_end_after_start')
  if (msg.includes('start must be the 1st')) return t('period_error_start_first')
  if (msg.includes('end must be the last day')) return t('period_error_end_last_day')
  if (msg.includes('exceeds maximum 18 months')) return t('period_error_max_18')
  return t('period_error_invalid')
}

export default function NewCompanyPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    }>
      <NewCompanyContent />
    </Suspense>
  )
}

const LOG = '[new-company]'

function logError(message: string, extra?: Record<string, unknown>) {
  console.error(LOG, message, extra ?? '')
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `new-company: ${message}`, extra }),
  }).catch(() => {})
}

function NewCompanyContent() {
  const router = useRouter()
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('companies_new')
  const STEP_INFO = buildStepInfo(t)

  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [settings, setSettings] = useState<Partial<CompanySettings>>({})
  const ticEnabled = ENABLED_EXTENSION_IDS.has('tic')
  const [ticLookup, setTicLookup] = useState<CompanyLookupResult | null>(null)

  const totalSteps = 4

  const [teamId, setTeamId] = useState<string | null>(null)

  // Verify auth and fetch team_id on mount
  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/login')
        return
      }

      // Fetch user's team_id
      const { data: teamMembership } = await supabase
        .from('team_members')
        .select('team_id')
        .eq('user_id', user.id)
        .limit(1)
        .maybeSingle()

      if (teamMembership?.team_id) {
        setTeamId(teamMembership.team_id)
      } else {
        // Ensure user has a team (fallback)
        const { data: newTeamId } = await supabase.rpc('ensure_user_team')
        setTeamId(newTeamId)
      }

      setIsLoading(false)
    }
    checkAuth()
  }, [supabase, router])

  const handleNext = async (stepData: Partial<CompanySettings>) => {
    if (currentStep === 1 && stepData.entity_type && stepData.entity_type !== settings.entity_type) {
      stepData = { ...stepData, org_number: '', company_name: '' }
      setTicLookup(null)
    }

    const mergedSettings = { ...settings, ...stepData }

    // Validate fiscal period at step 3 before advancing
    if (currentStep === 3) {
      const periodResult = computeFiscalPeriod(mergedSettings)
      if (periodResult.error) {
        toast({
          title: t('toast_invalid_fiscal_year'),
          description: translatePeriodError(periodResult.error, t),
          variant: 'destructive',
        })
        return
      }
    }

    // Steps 1-3: collect data client-side only, advance step
    if (currentStep < totalSteps) {
      setSettings(mergedSettings)
      setCurrentStep(currentStep + 1)
      return
    }

    // Step 4 (final): create everything via server action.
    // Going through a server action ensures that if the Next.js server is
    // unreachable, nothing touches Supabase: no ghost companies.
    const periodResult = computeFiscalPeriod(mergedSettings)
    if (periodResult.error) {
      toast({
        title: t('toast_invalid_fiscal_year'),
        description: translatePeriodError(periodResult.error, t),
        variant: 'destructive',
      })
      return
    }

    if (!teamId) {
      logError('handleNext aborted: no teamId')
      toast({ title: t('toast_error_title'), description: t('toast_no_team'), variant: 'destructive' })
      return
    }

    setIsSaving(true)
    try {
      const result = await createCompanyFromOnboarding({
        teamId,
        settings: mergedSettings as Record<string, unknown>,
        fiscalPeriod: {
          startDate: periodResult.startStr,
          endDate: periodResult.endStr,
          name: periodResult.periodName,
        },
      })

      if (result.error || !result.companyId) {
        logError('create company action failed', { error: result.error })
        toast({
          title: t('toast_error_title'),
          description: result.error || t('toast_create_failed'),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('toast_company_created'),
        description: t('toast_switched_to_new'),
      })
      router.push('/')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('create company action threw', { error: message })
      toast({ title: t('toast_error_title'), description: t('toast_unexpected_error'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const stepInfo = STEP_INFO[currentStep - 1]

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Header */}
      <header className="relative bg-[#141414] text-white overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" aria-hidden>
          <div
            className="absolute inset-0"
            style={{
              background: 'radial-gradient(ellipse at 30% -20%, rgba(255,255,255,0.04) 0%, transparent 50%)',
            }}
          />
          <span className="absolute -bottom-4 right-4 md:right-10 text-[120px] md:text-[160px] font-display font-bold text-white/[0.02] leading-none select-none">
            {String(currentStep).padStart(2, '0')}
          </span>
        </div>

        <div className="relative z-10 max-w-2xl mx-auto w-full px-6 md:px-10 pt-5 pb-6 md:pt-6 md:pb-8">
          <div className="flex items-center justify-between mb-5 md:mb-6">
            <div className="flex items-center gap-2.5">
              <Link
                href="/"
                className="flex items-center gap-2 text-white/60 hover:text-white transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <span className="font-display text-base tracking-tight" style={{ fontWeight: 700 }}>
                {branding.appName.toLowerCase()}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {STEP_INFO.map((_, i) => {
                const num = i + 1
                return (
                  <div
                    key={i}
                    className={cn(
                      'h-[3px] rounded-full transition-all duration-500',
                      num === currentStep && 'w-7 bg-white',
                      num < currentStep && 'w-4 bg-white/50',
                      num > currentStep && 'w-4 bg-white/[0.1]',
                    )}
                  />
                )
              })}
            </div>
            <span className="text-[10px] text-white/30 tracking-[0.15em] uppercase">
              {currentStep} / {totalSteps}
            </span>
          </div>

          <div key={`title-${currentStep}`} className="animate-fade-in">
            <h1 className="font-display text-2xl md:text-3xl tracking-tight leading-[1.1]">
              {stepInfo.title}
            </h1>
            <p className="text-white/40 mt-1.5 text-sm max-w-sm leading-relaxed">
              {stepInfo.subtitle}
            </p>
          </div>
        </div>
      </header>

      {/* Form content */}
      <main className="flex-1">
        <div className="max-w-lg mx-auto px-6 md:px-10 py-6 md:py-8">
          <div key={`step-${currentStep}`} className="animate-slide-up">
            {currentStep === 1 && (
              <Step1EntityType
                initialData={{ entity_type: settings.entity_type as EntityType }}
                onNext={(data) => handleNext(data)}
                isSaving={isSaving}
              />
            )}

            {currentStep === 2 && (
              <Step2CompanyDetails
                key={settings.entity_type}
                initialData={{
                  company_name: settings.company_name ?? undefined,
                  org_number: settings.org_number ?? undefined,
                  address_line1: settings.address_line1 ?? undefined,
                  postal_code: settings.postal_code ?? undefined,
                  city: settings.city ?? undefined,
                }}
                entityType={settings.entity_type as EntityType}
                ticEnabled={ticEnabled}
                onTicLookup={setTicLookup}
                onNext={(data) => handleNext(data)}
                onBack={handleBack}
                isSaving={isSaving}
              />
            )}

            {currentStep === 3 && (
              <Step3TaxRegistration
                initialData={{
                  f_skatt: settings.f_skatt ?? (ticLookup ? ticLookup.registration.fTax : undefined),
                  fiscal_year_start_month: settings.fiscal_year_start_month ?? undefined,
                }}
                entityType={settings.entity_type as EntityType}
                onNext={(data) => handleNext(data)}
                onBack={handleBack}
                isSaving={isSaving}
              />
            )}

            {currentStep === 4 && (
              <Step4VatAccounting
                initialData={{
                  vat_registered: settings.vat_registered ?? (ticLookup ? ticLookup.registration.vat : undefined),
                  vat_number: settings.vat_number ?? undefined,
                  moms_period: (settings.moms_period as MomsPeriod | null) ?? undefined,
                  accounting_method: (settings.accounting_method as 'accrual' | 'cash') ?? undefined,
                }}
                entityType={settings.entity_type as EntityType}
                orgNumber={settings.org_number ?? undefined}
                onNext={(data) => handleNext(data)}
                onBack={handleBack}
                isSaving={isSaving}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
