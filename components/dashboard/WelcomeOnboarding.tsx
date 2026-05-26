'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createCompanyFromOnboarding } from '@/lib/company/actions'
import { computeFiscalPeriod } from '@/lib/company/compute-fiscal-period'
import { useToast } from '@/components/ui/use-toast'
import { Building2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { getBranding } from '@/lib/branding/service'

const branding = getBranding()
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import type { CompanySettings, EntityType, MomsPeriod } from '@/types'

import Step1EntityType from '@/components/onboarding/Step1EntityType'
import Step2CompanyDetails from '@/components/onboarding/Step2CompanyDetails'
import Step3TaxRegistration from '@/components/onboarding/Step3TaxRegistration'
import Step4VatAccounting from '@/components/onboarding/Step4VatAccounting'

type TFn = (key: string, values?: Record<string, string | number>) => string

function buildStepInfo(t: TFn) {
  return [
    { title: t('step1_title'), subtitle: t('step1_subtitle') },
    { title: t('step2_title'), subtitle: t('step2_subtitle') },
    { title: t('step3_title'), subtitle: t('step3_subtitle') },
    { title: t('step4_title'), subtitle: t('step4_subtitle') },
  ]
}

function translatePeriodError(msg: string, t: TFn): string {
  if (msg.includes('end must be after')) return t('period_error_end_after_start')
  if (msg.includes('start must be the 1st')) return t('period_error_start_first')
  if (msg.includes('end must be the last day')) return t('period_error_end_last_day')
  if (msg.includes('exceeds maximum 18 months')) return t('period_error_max_18')
  return t('period_error_invalid')
}

const LOG = '[welcome-onboarding]'

function logError(message: string, extra?: Record<string, unknown>) {
  console.error(LOG, message, extra ?? '')
  fetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `welcome-onboarding: ${message}`, extra }),
  }).catch(() => {})
}

// Parse TIC v2's `startMonthDay` ("MM-DD" — e.g. "07-01") into a month
// number 1–12. Returns null on missing / malformed input so the caller
// can fall through to the manual picker default.
function parseStartMonthDay(value: string | null | undefined): number | null {
  if (!value) return null
  const match = /^(\d{1,2})-\d{1,2}$/.exec(value)
  if (!match) return null
  const month = Number(match[1])
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return month
}

interface WelcomeOnboardingProps {
  firstName?: string | null
  teamId: string
  skipWelcome?: boolean
  hasExistingCompanies?: boolean
  /** Pre-fill Step 2 org_number when the picker routed here via ?org_number=. */
  initialOrgNumber?: string
}

export default function WelcomeOnboarding({
  firstName,
  teamId,
  skipWelcome,
  hasExistingCompanies,
  initialOrgNumber,
}: WelcomeOnboardingProps) {
  const router = useRouter()
  const { toast } = useToast()
  const t = useTranslations('onboarding')
  const STEP_INFO = buildStepInfo(t)

  const [started, setStarted] = useState(skipWelcome ?? false)
  const [isSaving, setIsSaving] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [settings, setSettings] = useState<Partial<CompanySettings>>(
    initialOrgNumber ? { org_number: initialOrgNumber } : {},
  )
  const ticEnabled = ENABLED_EXTENSION_IDS.has('tic')
  const [ticLookup, setTicLookup] = useState<CompanyLookupResult | null>(null)

  const totalSteps = 4

  const hour = new Date().getHours()
  const greeting = hour < 5 ? t('greeting_night') : hour < 10 ? t('greeting_morning') : hour < 14 ? t('greeting_hello') : hour < 18 ? t('greeting_afternoon') : t('greeting_evening')

  const handleNext = async (stepData: Partial<CompanySettings>) => {
    // Reset org_number/company_name only on a genuine change (user going back
    // and picking a different entity type). First-time selection must not
    // wipe a pre-fill (e.g. ?org_number= deep-link from /select-company).
    if (
      currentStep === 1 &&
      stepData.entity_type &&
      settings.entity_type &&
      stepData.entity_type !== settings.entity_type
    ) {
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
    // unreachable, nothing touches Supabase — no ghost companies.
    const periodResult = computeFiscalPeriod(mergedSettings)
    if (periodResult.error) {
      toast({
        title: t('toast_invalid_fiscal_year'),
        description: translatePeriodError(periodResult.error, t),
        variant: 'destructive',
      })
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
        ticLookup,
      })

      if (result.error || !result.companyId) {
        logError('create company action failed', { error: result.error })
        let title = t('toast_error_title')
        let description: string = result.error || t('toast_create_failed')
        let backToStep2 = false
        if (result.error === 'org_number_exists') {
          title = t('toast_company_exists_title')
          description = t('toast_company_exists_description', { appName: branding.appName.toLowerCase() })
          backToStep2 = true
        } else if (result.error === 'org_number_invalid') {
          title = t('toast_org_invalid_title')
          description = t('toast_org_invalid_description')
          backToStep2 = true
        }
        toast({
          title,
          description,
          variant: 'destructive',
        })
        // Back user up to step 2 so they can correct the org number.
        if (backToStep2) {
          setCurrentStep(2)
        }
        return
      }

      console.log(LOG, 'onboarding completed', result.companyId)
      toast({
        title: t('toast_welcome_title'),
        description: t('toast_company_ready'),
      })
      router.push('/')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logError('create company action threw', { error: message })
      toast({ title: t('toast_unexpected_error'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
    }
  }

  const stepInfo = STEP_INFO[currentStep - 1]

  // Welcome screen — show before user clicks "Lägg till ditt första företag"
  if (!started) {
    return (
      <div className="flex flex-col items-start justify-center min-h-[60vh] animate-fade-in">
        <p className="text-muted-foreground/50 text-sm mb-2">{greeting}</p>
        <h1 className="font-display text-4xl md:text-5xl font-medium tracking-tight leading-[1.05] mb-10">
          {t('welcome_title', { appName: branding.appName })}
        </h1>
        <button
          onClick={() => setStarted(true)}
          className="px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/85 transition-colors duration-150 active:scale-[0.98]"
        >
          {hasExistingCompanies ? t('add_a_company') : t('add_first_company')}
        </button>
      </div>
    )
  }

  return (
    <div className="stagger-enter">
      {/* Greeting header */}
      <header className="mb-10">
        <h1 className="font-display text-2xl md:text-3xl font-medium tracking-tight">
          {greeting}{firstName ? `, ${firstName}` : ''}
        </h1>
        <p className="text-muted-foreground text-sm mt-1.5">
          {hasExistingCompanies ? t('add_company_subtitle') : t('add_first_company_subtitle')}
        </p>
      </header>

      {/* Onboarding card */}
      <div className="max-w-lg">
        <div className="rounded-xl border bg-card overflow-hidden" style={{ boxShadow: 'var(--shadow-md)' }}>
          {/* Card header with step info */}
          <div className="bg-[#141414] text-white px-6 py-5 relative overflow-hidden">
            <div className="absolute inset-0 pointer-events-none" aria-hidden>
              <div
                className="absolute inset-0"
                style={{
                  background: 'radial-gradient(ellipse at 30% -20%, rgba(255,255,255,0.04) 0%, transparent 50%)',
                }}
              />
            </div>

            <div className="relative z-10">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-white/60" />
                  <span className="text-xs text-white/40 tracking-wide uppercase">{t('new_company')}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {STEP_INFO.map((_, i) => {
                    const num = i + 1
                    return (
                      <div
                        key={i}
                        className={cn(
                          'h-[3px] rounded-full transition-all duration-500',
                          num === currentStep && 'w-6 bg-white',
                          num < currentStep && 'w-3 bg-white/50',
                          num > currentStep && 'w-3 bg-white/[0.1]',
                        )}
                      />
                    )
                  })}
                  <span className="text-[10px] text-white/30 ml-1.5">
                    {currentStep}/{totalSteps}
                  </span>
                </div>
              </div>

              <h2 className="font-display text-lg font-medium tracking-tight leading-tight">
                {stepInfo.title}
              </h2>
              <p className="text-white/40 mt-1 text-sm">
                {stepInfo.subtitle}
              </p>
            </div>
          </div>

          {/* Form content */}
          <div className="px-6 py-6">
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
                    // Prefer the user's previously-saved value, then fall back
                    // to TIC's v2 `fiscalYear.startMonthDay` (e.g. "07-01" →
                    // start month 7). Parsing the MM-DD lets us skip the
                    // manual end-month picker for the ~95% of companies that
                    // have a registered fiscal year in Bolagsverket.
                    fiscal_year_start_month:
                      settings.fiscal_year_start_month
                      ?? parseStartMonthDay(ticLookup?.fiscalYear?.startMonthDay)
                      ?? undefined,
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
        </div>
      </div>
    </div>
  )
}
