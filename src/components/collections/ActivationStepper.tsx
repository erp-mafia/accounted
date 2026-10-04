'use client'

import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsRowNote,
  SettingsSelect,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import {
  validateCompanyStep,
  validateKycStep,
  validateRulesStep,
  type ActivationErrorKey,
  type CompanyStepInput,
  type KycStepInput,
  type PayoutKind,
  type RulesStepInput,
} from '@/lib/collections/activation-form'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { cn } from '@/lib/utils'
import { collectionsAction, useCollectionsWords, type CollectionsSettingsData } from './collections-client'

/**
 * The activation, in the order the data allows (build spec 1.7, 3.2):
 * nothing about the company leaves the app before an owner or admin has read
 * the provider's terms and agreed. Consent creates the connection; the
 * company details, know-your-customer answers and rules stay in the browser
 * until "Skicka ansökan" sends them in one request.
 *
 * Each step is validated with the same rules the route enforces
 * (lib/collections/activation-form.ts), so an error is shown where it is
 * made, and a field error the route still finds sends the admin back to its
 * step.
 */

type Step = 'consent' | 'company' | 'kyc' | 'rules'
const STEPS: Step[] = ['consent', 'company', 'kyc', 'rules']
const STEP_LABELS: Record<Step, string> = { consent: 'step_consent', company: 'step_company', kyc: 'step_kyc', rules: 'step_rules' }

interface CompanyForm {
  name: string
  addressLine1: string
  addressLine2: string
  postalCode: string
  city: string
  email: string
  phone: string
  vatRegistered: boolean
  vatNumber: string
  ownerPersonalNumber: string
  /** `${cashAccountId}:${kind}`, or '' when none is chosen. */
  payout: string
}

interface KycForm {
  businessDescription: string
  invoicesAbroad: boolean
  invoicesAbroadDescription: string
  pep: boolean
  pepDescription: string
  sanctions: boolean
  sanctionsDescription: string
}

interface RulesForm {
  minimumAmount: string
  defaultStartStep: 'reminder' | 'collection'
  reminderFeeTermsSince: string
  interestPercent: string
  interestSince: string
  ladderMode: '' | 'off' | 'staged'
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())
const toNumber = (value: string): number => Number(value.replace(/\s/g, '').replace(',', '.'))

function companyInput(form: CompanyForm): CompanyStepInput {
  const [cashAccountId, kind] = form.payout.split(':')
  return {
    name: form.name,
    addressLine1: form.addressLine1,
    addressLine2: orNull(form.addressLine2),
    postalCode: form.postalCode,
    city: form.city,
    email: form.email.trim(),
    phone: orNull(form.phone),
    vatRegistered: form.vatRegistered,
    vatNumber: form.vatRegistered ? orNull(form.vatNumber) : null,
    ownerPersonalNumber: orNull(form.ownerPersonalNumber),
    payout: cashAccountId && kind ? { cashAccountId, kind: kind as PayoutKind } : null,
  }
}

function kycInput(form: KycForm): KycStepInput {
  return {
    businessDescription: form.businessDescription,
    invoicesAbroad: form.invoicesAbroad,
    invoicesAbroadDescription: form.invoicesAbroad ? orNull(form.invoicesAbroadDescription) : null,
    pep: form.pep,
    pepDescription: form.pep ? orNull(form.pepDescription) : null,
    sanctions: form.sanctions,
    sanctionsDescription: form.sanctions ? orNull(form.sanctionsDescription) : null,
  }
}

function rulesInput(form: RulesForm, ladderOffered: boolean): RulesStepInput {
  const interest = orNull(form.interestPercent) || orNull(form.interestSince)
  return {
    minimumAmount: toNumber(form.minimumAmount),
    defaultStartStep: form.defaultStartStep,
    reminderFeeTermsSince: orNull(form.reminderFeeTermsSince),
    lateInterest: interest ? { percent: toNumber(form.interestPercent), agreedSince: form.interestSince.trim() } : null,
    ladderMode: ladderOffered ? (form.ladderMode === '' ? null : form.ladderMode) : 'off',
  }
}

/** Route field paths ("company.postalCode") to the step that owns them. */
function stepOfField(field: string): Step {
  if (field.startsWith('company.')) return 'company'
  if (field.startsWith('kyc.')) return 'kyc'
  return 'rules'
}

interface ActivationStepperProps {
  data: CollectionsSettingsData
  onChanged: () => Promise<void> | void
}

export function ActivationStepper({ data, onChanged }: ActivationStepperProps) {
  const { tp, t, locale } = useCollectionsWords(data.availability.displayName ?? data.connection?.displayName)
  const profile = data.provider?.profile ?? null
  const activation = data.activation
  const ladderOffered = data.availability.ladderEnabled

  const [step, setStep] = useState<Step>(data.connection ? 'company' : 'consent')
  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptData, setAcceptData] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, ActivationErrorKey>>({})

  const payoutOptions = useMemo(() => activation?.payoutOptions ?? [], [activation])
  const defaultPayout = useMemo(() => {
    const option = payoutOptions.find((o) => o.cashAccountId === activation?.defaultPayoutCashAccountId) ?? payoutOptions[0]
    return option ? `${option.cashAccountId}:${option.kind}` : ''
  }, [payoutOptions, activation])

  const company0 = activation?.company
  const [company, setCompany] = useState<CompanyForm>({
    name: company0?.name ?? '',
    addressLine1: company0?.addressLine1 ?? '',
    addressLine2: company0?.addressLine2 ?? '',
    postalCode: company0?.postalCode ?? '',
    city: company0?.city ?? '',
    email: company0?.email ?? '',
    phone: company0?.phone ?? '',
    vatRegistered: company0?.vatRegistered ?? false,
    vatNumber: company0?.vatNumber ?? '',
    ownerPersonalNumber: company0?.ownerPersonalNumber ?? '',
    payout: defaultPayout,
  })
  const [kyc, setKyc] = useState<KycForm>({
    businessDescription: '',
    invoicesAbroad: false,
    invoicesAbroadDescription: '',
    pep: false,
    pepDescription: '',
    sanctions: false,
    sanctionsDescription: '',
  })
  const [rules, setRules] = useState<RulesForm>({
    minimumAmount: '100',
    defaultStartStep: 'reminder',
    reminderFeeTermsSince: '',
    interestPercent: '',
    interestSince: '',
    ladderMode: ladderOffered ? '' : 'off',
  })

  if (!activation || !profile) return null
  const soleTrader = activation.company.soleTrader

  const errorText = (field: string): string | null => (errors[field] ? t(`error_${errors[field]}`) : null)
  const fieldError = (field: string) => {
    const text = errorText(field)
    return text ? <SettingsRowNote className="basis-full text-destructive">{text}</SettingsRowNote> : null
  }

  async function giveConsent() {
    setBusy(true)
    setMessage(null)
    const result = await collectionsAction(
      '/consent',
      { termsVersion: profile!.termsVersion, dpaVersion: profile!.dpaVersion, acceptTerms: true, acceptDataSharing: true },
      locale,
    )
    setBusy(false)
    if (!result.ok) {
      setMessage(result.message)
      return
    }
    setStep('company')
    await onChanged()
  }

  function prefixed(prefix: string, found: Record<string, ActivationErrorKey | undefined>): Record<string, ActivationErrorKey> {
    const out: Record<string, ActivationErrorKey> = {}
    for (const [field, key] of Object.entries(found)) if (key) out[`${prefix}.${field}`] = key
    return out
  }

  function validate(which: Step): Record<string, ActivationErrorKey> {
    if (which === 'company') return prefixed('company', validateCompanyStep(companyInput(company), { soleTrader }))
    if (which === 'kyc') return prefixed('kyc', validateKycStep(kycInput(kyc)))
    if (which === 'rules') {
      return prefixed('rules', validateRulesStep(rulesInput(rules, ladderOffered), { today: todayIsoStockholm(), requireLadderChoice: ladderOffered }))
    }
    return {}
  }

  function next() {
    const found = validate(step)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setStep(STEPS[STEPS.indexOf(step) + 1] ?? step)
  }

  async function submit() {
    const found = { ...validate('company'), ...validate('kyc'), ...validate('rules') }
    setErrors(found)
    if (Object.keys(found).length > 0) {
      setStep(stepOfField(Object.keys(found)[0]!))
      return
    }
    setBusy(true)
    setMessage(null)
    const result = await collectionsAction(
      '/onboarding',
      { company: companyInput(company), kyc: kycInput(kyc), rules: rulesInput(rules, ladderOffered) },
      locale,
    )
    setBusy(false)
    if (!result.ok) {
      if (Object.keys(result.fieldErrors).length > 0) {
        setErrors(result.fieldErrors)
        setStep(stepOfField(Object.keys(result.fieldErrors)[0]!))
      } else {
        setMessage(result.message)
      }
      // A timed-out application is already submitted: the page shows its status.
      await onChanged()
      return
    }
    await onChanged()
  }

  const stepIndex = STEPS.indexOf(step)
  const payoutLabel = (kind: PayoutKind) => t(kind === 'bankgiro' ? 'payout_bankgiro' : kind === 'plusgiro' ? 'payout_plusgiro' : 'payout_bank_account')

  return (
    <div>
      <ol aria-label={t('step_of', { current: stepIndex + 1, total: STEPS.length })} className="flex flex-wrap gap-x-6 gap-y-2 pt-8 text-[12.5px]">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className={cn('flex items-center gap-2', s === step ? 'text-foreground' : 'text-muted-foreground')}
          >
            <span
              className={cn(
                'grid h-5 w-5 place-items-center rounded-full border text-[11px] tabular-nums',
                i < stepIndex ? 'border-foreground bg-foreground text-background' : s === step ? 'border-foreground' : 'border-border',
              )}
              aria-hidden="true"
            >
              {i < stepIndex ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            {t(STEP_LABELS[s])}
          </li>
        ))}
      </ol>

      {step === 'consent' && (
        <SettingsGroup label={t('step_consent')}>
          {profile.termsUrl ? (
            <SettingsRow label={tp('terms_read')}>
              <a href={profile.termsUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {profile.termsVersion ? `${profile.displayName}, ${profile.termsVersion}` : profile.displayName}
              </a>
            </SettingsRow>
          ) : null}
          {profile.termsSummarySv ? (
            <SettingsRow label={t('terms_summary_heading')} align="baseline">
              <span className="whitespace-pre-line text-muted-foreground">{profile.termsSummarySv}</span>
            </SettingsRow>
          ) : null}
          {profile.feeSummarySv ? (
            <SettingsRow label={t('fee_summary_heading')} align="baseline">
              <span className="whitespace-pre-line text-muted-foreground">{profile.feeSummarySv}</span>
            </SettingsRow>
          ) : null}
          {profile.dpaUrl ? (
            <SettingsRow label={tp('dpa_read')}>
              <a href={profile.dpaUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {profile.dpaVersion ?? profile.displayName}
              </a>
            </SettingsRow>
          ) : null}
          <label className="flex items-start gap-3 border-b border-border py-3 text-[13px]">
            <Checkbox className="mt-0.5" checked={acceptTerms} onCheckedChange={(v) => setAcceptTerms(v === true)} />
            <span>{tp('consent_terms')}</span>
          </label>
          <label className="flex items-start gap-3 border-b border-border py-3 text-[13px]">
            <Checkbox className="mt-0.5" checked={acceptData} onCheckedChange={(v) => setAcceptData(v === true)} />
            <span>{tp('consent_data')}</span>
          </label>
        </SettingsGroup>
      )}

      {step === 'company' && (
        <SettingsGroup label={t('step_company')}>
          <SettingsRow label={t('field_org_number')} htmlFor="coll-org">
            <SettingsInput id="coll-org" value={activation.company.orgNumber ?? ''} disabled />
          </SettingsRow>
          <SettingsRow label={t('field_name')} htmlFor="coll-name" align="baseline">
            <SettingsInput id="coll-name" value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} />
            {fieldError('company.name')}
          </SettingsRow>
          <SettingsRow label={t('field_address')} htmlFor="coll-a1" align="baseline">
            <SettingsInput id="coll-a1" value={company.addressLine1} onChange={(e) => setCompany({ ...company, addressLine1: e.target.value })} />
            {fieldError('company.addressLine1')}
          </SettingsRow>
          <SettingsRow label={t('field_address_line2')} htmlFor="coll-a2" align="baseline">
            <SettingsInput id="coll-a2" value={company.addressLine2} onChange={(e) => setCompany({ ...company, addressLine2: e.target.value })} />
            {fieldError('company.addressLine2')}
          </SettingsRow>
          <SettingsRow label={t('field_postal_code')} htmlFor="coll-pc" align="baseline">
            <SettingsInput id="coll-pc" inputMode="numeric" value={company.postalCode} onChange={(e) => setCompany({ ...company, postalCode: e.target.value })} />
            {fieldError('company.postalCode')}
          </SettingsRow>
          <SettingsRow label={t('field_city')} htmlFor="coll-city" align="baseline">
            <SettingsInput id="coll-city" value={company.city} onChange={(e) => setCompany({ ...company, city: e.target.value })} />
            {fieldError('company.city')}
          </SettingsRow>
          <SettingsRow label={t('field_email')} htmlFor="coll-email" align="baseline">
            <SettingsInput id="coll-email" type="email" value={company.email} onChange={(e) => setCompany({ ...company, email: e.target.value })} />
            {fieldError('company.email')}
          </SettingsRow>
          <SettingsRow label={t('field_phone')} htmlFor="coll-phone" align="baseline">
            <SettingsInput id="coll-phone" type="tel" value={company.phone} onChange={(e) => setCompany({ ...company, phone: e.target.value })} />
            {fieldError('company.phone')}
          </SettingsRow>
          <SettingsRow label={t('field_payout')} htmlFor="coll-payout" align="baseline">
            {payoutOptions.length > 0 ? (
              <SettingsSelect id="coll-payout" value={company.payout} onChange={(e) => setCompany({ ...company, payout: e.target.value })}>
                {payoutOptions.map((o) => (
                  <option key={`${o.cashAccountId}:${o.kind}`} value={`${o.cashAccountId}:${o.kind}`}>
                    {`${payoutLabel(o.kind)} ${o.number}, ${o.accountName ?? o.ledgerAccount} (${o.ledgerAccount})`}
                  </option>
                ))}
              </SettingsSelect>
            ) : (
              <SettingsRowNote className="text-attn">{t('payout_none')}</SettingsRowNote>
            )}
            {fieldError('company.payout')}
          </SettingsRow>
          <SettingsRow label={t('field_vat_registered')}>
            <Switch checked={company.vatRegistered} onCheckedChange={(v) => setCompany({ ...company, vatRegistered: v })} aria-label={t('field_vat_registered')} />
          </SettingsRow>
          <SettingsReveal open={company.vatRegistered}>
            <SettingsRow label={t('field_vat_number')} htmlFor="coll-vat" align="baseline">
              <SettingsInput id="coll-vat" value={company.vatNumber} onChange={(e) => setCompany({ ...company, vatNumber: e.target.value })} />
              {fieldError('company.vatNumber')}
            </SettingsRow>
          </SettingsReveal>
          {soleTrader ? (
            <SettingsRow label={t('field_owner_personal_number')} htmlFor="coll-owner" help={tp('sole_trader_note')} align="baseline">
              <SettingsInput
                id="coll-owner"
                inputMode="numeric"
                value={company.ownerPersonalNumber}
                onChange={(e) => setCompany({ ...company, ownerPersonalNumber: e.target.value })}
              />
              {fieldError('company.ownerPersonalNumber')}
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      )}

      {step === 'kyc' && (
        <SettingsGroup label={t('step_kyc')} help={tp('kyc_intro')}>
          <SettingsRow label={t('kyc_business')} htmlFor="coll-business" align="baseline">
            <SettingsTextarea id="coll-business" value={kyc.businessDescription} onChange={(e) => setKyc({ ...kyc, businessDescription: e.target.value })} />
            {fieldError('kyc.businessDescription')}
          </SettingsRow>
          {(
            [
              ['invoicesAbroad', 'invoicesAbroadDescription', 'kyc_abroad', 'kyc_abroad_describe'],
              ['pep', 'pepDescription', 'kyc_pep', 'kyc_describe'],
              ['sanctions', 'sanctionsDescription', 'kyc_sanctions', 'kyc_describe'],
            ] as const
          ).map(([flag, description, question, describe]) => (
            <div key={flag}>
              <SettingsRow label={t(question)}>
                <Switch checked={kyc[flag]} onCheckedChange={(v) => setKyc({ ...kyc, [flag]: v })} aria-label={t(question)} />
              </SettingsRow>
              <SettingsReveal open={kyc[flag]}>
                <SettingsRow label={t(describe)} htmlFor={`coll-${description}`} align="baseline">
                  <SettingsTextarea
                    id={`coll-${description}`}
                    value={kyc[description]}
                    onChange={(e) => setKyc({ ...kyc, [description]: e.target.value })}
                  />
                  {fieldError(`kyc.${description}`)}
                </SettingsRow>
              </SettingsReveal>
            </div>
          ))}
        </SettingsGroup>
      )}

      {step === 'rules' && (
        <SettingsGroup label={t('step_rules')}>
          <SettingsRow label={t('rule_legal_action')} help={t('rule_legal_action_locked')}>
            <Switch checked disabled aria-label={t('rule_legal_action')} />
          </SettingsRow>
          <SettingsRow label={t('rule_collection_notice')} help={t('rule_collection_notice_locked')}>
            <Switch checked disabled aria-label={t('rule_collection_notice')} />
          </SettingsRow>
          <SettingsRow label={t('rule_minimum')} htmlFor="coll-min" align="baseline">
            <SettingsInput id="coll-min" inputMode="decimal" className="tabular-nums" value={rules.minimumAmount} onChange={(e) => setRules({ ...rules, minimumAmount: e.target.value })} />
            {fieldError('rules.minimumAmount')}
          </SettingsRow>
          <SettingsRow label={t('rule_start_step')} htmlFor="coll-start">
            <SettingsSelect
              id="coll-start"
              value={rules.defaultStartStep}
              onChange={(e) => setRules({ ...rules, defaultStartStep: e.target.value as RulesForm['defaultStartStep'] })}
            >
              <option value="reminder">{t('start_reminder')}</option>
              <option value="collection">{t('start_collection')}</option>
            </SettingsSelect>
          </SettingsRow>
          <SettingsRow label={t('rule_reminder_fee_since')} htmlFor="coll-fee" help={t('rule_reminder_fee_help')} align="baseline">
            <SettingsInput id="coll-fee" type="date" value={rules.reminderFeeTermsSince} onChange={(e) => setRules({ ...rules, reminderFeeTermsSince: e.target.value })} />
            {fieldError('rules.reminderFeeTermsSince')}
          </SettingsRow>
          <SettingsRow label={t('rule_interest')} htmlFor="coll-interest" help={t('rule_interest_help')} align="baseline">
            <SettingsInput
              id="coll-interest"
              inputMode="decimal"
              className="tabular-nums"
              value={rules.interestPercent}
              onChange={(e) => setRules({ ...rules, interestPercent: e.target.value })}
            />
            {fieldError('rules.lateInterestPercent')}
          </SettingsRow>
          <SettingsReveal open={rules.interestPercent.trim() !== '' || rules.interestSince.trim() !== ''}>
            <SettingsRow label={t('rule_interest_since')} htmlFor="coll-interest-since" align="baseline">
              <SettingsInput id="coll-interest-since" type="date" value={rules.interestSince} onChange={(e) => setRules({ ...rules, interestSince: e.target.value })} />
              {fieldError('rules.lateInterestAgreedSince')}
            </SettingsRow>
          </SettingsReveal>
          {ladderOffered ? (
            <SettingsRow label={t('rule_reminders_choice')} htmlFor="coll-ladder" help={tp('reminders_choice_off_note')} align="baseline">
              <SettingsSelect
                id="coll-ladder"
                value={rules.ladderMode}
                onChange={(e) => setRules({ ...rules, ladderMode: e.target.value as RulesForm['ladderMode'] })}
              >
                <option value="">{t('reminders_choice_required')}</option>
                <option value="staged">{t('reminders_choice_staged')}</option>
                <option value="off">{t('reminders_choice_off')}</option>
              </SettingsSelect>
              {fieldError('rules.ladderMode')}
            </SettingsRow>
          ) : (
            <SettingsRow label={t('rule_reminders_choice')} help={tp('reminders_choice_off_note')}>
              <SettingsInput value={t('reminders_choice_off')} disabled />
            </SettingsRow>
          )}
        </SettingsGroup>
      )}

      {message ? <p className="pt-4 text-[12.5px] text-attn">{message}</p> : null}

      <div className="flex items-center justify-end gap-3 pt-6">
        {step !== 'consent' && step !== 'company' ? (
          <Button variant="outline" onClick={() => setStep(STEPS[stepIndex - 1]!)} disabled={busy}>
            {t('back')}
          </Button>
        ) : null}
        {step === 'consent' ? (
          <Button onClick={giveConsent} disabled={!acceptTerms || !acceptData} loading={busy}>
            {t('continue')}
          </Button>
        ) : step === 'rules' ? (
          <Button onClick={submit} loading={busy}>
            {t('submit')}
          </Button>
        ) : (
          <Button onClick={next} disabled={step === 'company' && payoutOptions.length === 0}>
            {t('next')}
          </Button>
        )}
      </div>
    </div>
  )
}
