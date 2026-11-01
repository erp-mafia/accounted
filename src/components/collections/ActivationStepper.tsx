'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { BrandMark } from '@/components/parties/BrandMark'
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
  activationCanSubmit,
  activationRequests,
  defaultActivationRules,
  kycDescriptionShown,
  payoutNumberText,
  validateCompanyStep,
  validateKycStep,
  type ActivationErrorKey,
  type CompanyStepInput,
  type KycStepInput,
  type PayoutKind,
} from '@/lib/collections/activation-form'
import { formatKronor } from '@/lib/collections/amount-text'
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { collectionsAction, useCollectionsWords, type CollectionsSettingsData } from './collections-client'

/**
 * The activation on one screen, asking only what the law and the provider
 * require (build spec 1.7, 3.2): the provider's terms and the data sharing,
 * the company's details, and the know-your-customer questions. The rules
 * start from defaults (lib/collections/activation-form.ts
 * defaultActivationRules) and are edited under Regler once the connection is
 * active.
 *
 * Nothing about the company leaves the app before an owner or admin has read
 * the terms and agreed: "Skicka ansökan" sends the consent first (it creates
 * the connection), then the application, in the same click. Every field is
 * validated with the same rules the route enforces, so an error shows where
 * it is made.
 */

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
  /** `${cashAccountId}:${kind}`, or '' when none is chosen. */
  payout: string
}

/** The yes/no questions start unanswered (null): no answer is given for the admin. */
interface KycForm {
  businessDescription: string
  invoicesAbroad: boolean | null
  invoicesAbroadDescription: string
  pep: boolean | null
  pepDescription: string
  sanctions: boolean | null
  sanctionsDescription: string
}

const answerValue = (answer: boolean | null): '' | 'yes' | 'no' => (answer === null ? '' : answer ? 'yes' : 'no')
const answerOf = (value: string): boolean | null => (value === 'yes' ? true : value === 'no' ? false : null)

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

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
    payout: cashAccountId && kind ? { cashAccountId, kind: kind as PayoutKind } : null,
  }
}

function kycInput(form: KycForm): KycStepInput {
  return {
    businessDescription: form.businessDescription,
    invoicesAbroad: form.invoicesAbroad,
    invoicesAbroadDescription: form.invoicesAbroad === true ? orNull(form.invoicesAbroadDescription) : null,
    pep: form.pep,
    pepDescription: form.pep === true ? orNull(form.pepDescription) : null,
    sanctions: form.sanctions,
    sanctionsDescription: form.sanctions === true ? orNull(form.sanctionsDescription) : null,
  }
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

  const [acceptTerms, setAcceptTerms] = useState(false)
  const [acceptData, setAcceptData] = useState(false)
  // The consent went through in this session: a retry after a field error sends only the application.
  const [consented, setConsented] = useState(false)
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
    payout: defaultPayout,
  })
  const [kyc, setKyc] = useState<KycForm>({
    businessDescription: '',
    invoicesAbroad: null,
    invoicesAbroadDescription: '',
    pep: null,
    pepDescription: '',
    sanctions: null,
    sanctionsDescription: '',
  })

  if (!activation || !profile) return null
  const connected = !!data.connection || consented
  const rules = defaultActivationRules(ladderOffered)

  const errorText = (field: string): string | null => (errors[field] ? t(`error_${errors[field]}`) : null)
  const fieldError = (field: string) => {
    const text = errorText(field)
    return text ? <SettingsRowNote className="basis-full text-destructive">{text}</SettingsRowNote> : null
  }

  function prefixed(prefix: string, found: Record<string, ActivationErrorKey | undefined>): Record<string, ActivationErrorKey> {
    const out: Record<string, ActivationErrorKey> = {}
    for (const [field, key] of Object.entries(found)) if (key) out[`${prefix}.${field}`] = key
    return out
  }

  async function submit() {
    const found = {
      ...prefixed('company', validateCompanyStep(companyInput(company))),
      ...prefixed('kyc', validateKycStep(kycInput(kyc))),
    }
    setErrors(found)
    if (Object.keys(found).length > 0) return
    setBusy(true)
    setMessage(null)
    for (const request of activationRequests(connected)) {
      if (request === 'consent') {
        const consent = await collectionsAction(
          '/consent',
          { termsVersion: profile!.termsVersion, dpaVersion: profile!.dpaVersion, acceptTerms: true, acceptDataSharing: true },
          locale,
        )
        if (!consent.ok) {
          setBusy(false)
          setMessage(consent.message)
          return
        }
        setConsented(true)
        continue
      }
      const result = await collectionsAction('/onboarding', { company: companyInput(company), kyc: kycInput(kyc), rules }, locale)
      setBusy(false)
      if (!result.ok && Object.keys(result.fieldErrors).length > 0) {
        // Keep the form as typed: the admin fixes the field and sends again.
        setErrors(result.fieldErrors)
        return
      }
      if (!result.ok) setMessage(result.message)
      // Sent, or timed out after it was submitted: the page shows the application's status.
      await onChanged()
      return
    }
  }

  const payoutLabel = (kind: PayoutKind) => t(kind === 'bankgiro' ? 'payout_bankgiro' : kind === 'plusgiro' ? 'payout_plusgiro' : 'payout_bank_account')
  const canSubmit = activationCanSubmit({ connected, acceptTerms, acceptDataSharing: acceptData, payoutOptions: payoutOptions.length })

  return (
    <div>
      {!connected && (
        <SettingsGroup label={t('step_consent')}>
          {profile.termsUrl ? (
            <SettingsRow label={tp('terms_read')}>
              <span className="inline-flex items-center gap-2">
                <BrandMark name={profile.displayName} variant="mark" size={22} logoUrl={data.availability.markUrl} />
                <a href={profile.termsUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  {profile.termsVersion ? `${profile.displayName}, ${profile.termsVersion}` : profile.displayName}
                </a>
              </span>
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

      <SettingsGroup label={t('step_company')}>
        <SettingsRow label={t('field_org_number')} htmlFor="coll-org">
          <SettingsInput id="coll-org" value={activation.company.orgNumber ? formatOrgNumberDisplay(activation.company.orgNumber) : ''} disabled />
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
                  {`${payoutLabel(o.kind)} ${payoutNumberText(o)}, ${o.accountName ?? o.ledgerAccount} (${o.ledgerAccount})`}
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
      </SettingsGroup>

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
            <SettingsRow label={t(question)} htmlFor={`coll-${flag}`} align="baseline">
              <SettingsSelect id={`coll-${flag}`} value={answerValue(kyc[flag])} onChange={(e) => setKyc({ ...kyc, [flag]: answerOf(e.target.value) })}>
                <option value="">{t('kyc_answer_choose')}</option>
                <option value="no">{t('kyc_answer_no')}</option>
                <option value="yes">{t('kyc_answer_yes')}</option>
              </SettingsSelect>
              {fieldError(`kyc.${flag}`)}
            </SettingsRow>
            {/* Mounted only after Ja: after Nej or no answer the box is not on the page at all. */}
            {kycDescriptionShown(kyc[flag]) && (
              <div className="ml-3 border-l border-border pl-4 animate-fade-in">
                <SettingsRow label={t(describe)} htmlFor={`coll-${description}`} align="baseline">
                  <SettingsTextarea id={`coll-${description}`} value={kyc[description]} onChange={(e) => setKyc({ ...kyc, [description]: e.target.value })} />
                  {fieldError(`kyc.${description}`)}
                </SettingsRow>
              </div>
            )}
          </div>
        ))}
      </SettingsGroup>

      {/* The rules start from defaults; they are edited under Regler once the connection is active. */}
      <p className="pt-6 text-[12.5px] text-muted-foreground">
        {tp(rules.ladderMode === 'staged' ? 'activation_rules_note_ladder' : 'activation_rules_note', {
          amount: formatKronor(rules.minimumAmount),
        })}
      </p>

      {message ? <p className="pt-4 text-[12.5px] text-attn">{message}</p> : null}

      <div className="flex items-center justify-end gap-3 pt-6">
        <Button onClick={submit} disabled={!canSubmit} loading={busy}>
          {t('submit')}
        </Button>
      </div>
    </div>
  )
}
