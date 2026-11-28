'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { byEntityType, isEntityType } from '@/lib/company/entity-type'
import { Switch } from '@/components/ui/switch'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { useFormat } from '@/lib/hooks/use-format'
import { registrationShownAsFact, type RegistryRegistrations } from '@/lib/company/registry-registrations'
import { formatAmount } from '@/lib/utils'
import type { KuSignalTrigger } from '@/lib/tax/ku-signal'
import type { CompanySettings } from '@/types'

interface TaxSettingsFormProps {
  settings: CompanySettings
  /** Ledger-derived signal: EU sales in the declaration's rutor 35/38/39. */
  euSalesDetected?: boolean
  /** Ledger-derived signal: EU purchases in the declaration's rutor 20/21/37. */
  euPurchasesDetected?: boolean
  /** Ledger-derived signal: what calls for kontrolluppgifter (interest on an ägarlån, utdelning). */
  kuTriggers?: KuSignalTrigger[]
  /** Invoice-derived signal: invoices with ROT/RUT deductions exist. */
  rotRutSignalDetected?: boolean
  /**
   * The form Bolagsverket registers the company as, when it is one Accounted
   * cannot represent yet (a handelsbolag or kommanditbolag set up as another
   * form): named beside the form the books follow (PH 237).
   */
  registryFormLabel?: string | null
  /** What the registry snapshot says about F-skatt and moms, and when it was read. */
  registryRegistrations?: RegistryRegistrations | null
}

/**
 * A registration the registry snapshot and the saved setting both answer yes:
 * shown as that fact with its source and date instead of a switch. "Ändra"
 * brings back the switch, the correction the row always had.
 */
function RegistryFact({ readAt, onChange }: { readAt: string | null; onChange: () => void }) {
  const t = useTranslations('settings_tax_form')
  const { formatDateLong } = useFormat()
  return (
    <>
      <span>{t('registry_fact_yes')}</span>
      <SettingsRowNote>
        {readAt ? t('registry_fact_source_dated', { date: formatDateLong(readAt) }) : t('registry_fact_source')}
      </SettingsRowNote>
      <SettingsRowEnd>
        <button type="button" className={QUIET_LINK_CLASS} onClick={onChange}>
          {t('registry_fact_change')}
        </button>
      </SettingsRowEnd>
    </>
  )
}

/**
 * Ledger/invoice-derived suggestion (EU sales, KU, ROT/RUT) as one visible
 * warning-tone sentence. The full body, including the legal deadlines and
 * late-fee amounts, lives behind the "?" so the signal stays a single line.
 */
function SignalLine({ text, help }: { text: string; help: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 border-b-hairline px-1 py-3 text-xs leading-relaxed text-attn">
      <span>{text}</span>
      <HelpPopover className="shrink-0">{help}</HelpPopover>
    </p>
  )
}

export function TaxSettingsForm({
  settings,
  euSalesDetected = false,
  euPurchasesDetected = false,
  kuTriggers = [],
  rotRutSignalDetected = false,
  registryFormLabel = null,
  registryRegistrations = null,
}: TaxSettingsFormProps) {
  const t = useTranslations('settings_tax_form')
  const [vatRegistered, setVatRegistered] = useState(settings.vat_registered ?? false)
  const [fSkatt, setFSkatt] = useState(settings.f_skatt ?? true)
  // A switch once opened stays a switch: the snapshot loads after the form,
  // and a fact must never stand over a value the person changed.
  const [fSkattAsked, setFSkattAsked] = useState(false)
  const [vatAsked, setVatAsked] = useState(false)
  const fSkattFact = !fSkattAsked && fSkatt && registrationShownAsFact(settings.f_skatt, registryRegistrations?.fTax)
  const vatFact = !vatAsked && vatRegistered && registrationShownAsFact(settings.vat_registered, registryRegistrations?.vat)
  const [momsPeriod, setMomsPeriod] = useState(settings.moms_period || '')
  const [vatTaxableBaseOver40m, setVatTaxableBaseOver40m] = useState(
    settings.vat_taxable_base_over_40m ?? false,
  )
  const [hasEuTrade, setHasEuTrade] = useState(settings.vat_has_eu_trade ?? false)
  const [psEnabled, setPsEnabled] = useState(settings.periodisk_sammanstallning_enabled ?? false)
  const [kuEnabled, setKuEnabled] = useState(settings.kontrolluppgifter_enabled ?? false)
  const [rotRutEnabled, setRotRutEnabled] = useState(settings.rot_rut_enabled ?? false)
  const [ossEnabled, setOssEnabled] = useState(settings.oss_enabled ?? false)
  const [iossEnabled, setIossEnabled] = useState(settings.ioss_enabled ?? false)
  const [intrastatEnabled, setIntrastatEnabled] = useState(settings.intrastat_enabled ?? false)
  const [punktskattEnabled, setPunktskattEnabled] = useState(settings.punktskatt_enabled ?? false)
  const [fyllnadEnabled, setFyllnadEnabled] = useState(
    settings.fyllnadsinbetalning_enabled ?? false,
  )

  const isEnskildFirma = settings.entity_type === 'enskild_firma'

  return (
    <div>
      <SettingsGroup label={t('tax_vat_heading')}>
        {/* Entity type: read-only. Changing it is a support operation. */}
        <SettingsRow label={t('entity_form_heading')} help={t('entity_form_help')}>
          <span className="text-sm">
            {isEntityType(settings.entity_type)
              ? byEntityType(settings.entity_type, {
                  aktiebolag: t('entity_aktiebolag'),
                  enskild_firma: t('entity_enskild_firma'),
                  ideell_forening: t('entity_ideell_forening'),
                  ekonomisk_forening: t('entity_ekonomisk_forening'),
                  bostadsrattsforening: t('entity_bostadsrattsforening'),
                })
              : ''}
          </span>
          {registryFormLabel && (
            <SettingsRowNote className="basis-full">
              {t('entity_registry_unsupported', { registry: registryFormLabel })}
            </SettingsRowNote>
          )}
        </SettingsRow>

        <SettingsRow label={t('f_skatt_label')} htmlFor={fSkattFact ? undefined : 'f_skatt'} help={t('f_skatt_help')}>
          {fSkattFact ? (
            <RegistryFact readAt={registryRegistrations?.readAt ?? null} onChange={() => setFSkattAsked(true)} />
          ) : (
            <Switch
              id="f_skatt"
              // Opened through Ändra: focus lands on the switch it brought back.
              autoFocus={fSkattAsked}
              checked={fSkatt}
              onCheckedChange={(v) => setFSkatt(v === true)}
            />
          )}
          <input type="hidden" name="f_skatt" value={fSkatt ? 'true' : 'false'} />
        </SettingsRow>

        <SettingsRow
          label={t('vat_registered_label')}
          htmlFor={vatFact ? undefined : 'vat_registered'}
          help={t('vat_registered_help')}
          borderless={vatRegistered}
        >
          {vatFact ? (
            <RegistryFact readAt={registryRegistrations?.readAt ?? null} onChange={() => setVatAsked(true)} />
          ) : (
            <Switch
              id="vat_registered"
              autoFocus={vatAsked}
              checked={vatRegistered}
              onCheckedChange={(value) => {
                const checked = value === true
                setVatRegistered(checked)
                if (checked && vatTaxableBaseOver40m) setMomsPeriod('monthly')
              }}
            />
          )}
          <input type="hidden" name="vat_registered" value={vatRegistered ? 'true' : 'false'} />
        </SettingsRow>

        {euSalesDetected && vatRegistered && (!hasEuTrade || !psEnabled) && (
          <SignalLine
            text={t('eu_trade_suggestion_title')}
            help={t('eu_trade_suggestion_help')}
          />
        )}
        {/* EU purchases alone change only the helårsmoms date, so the
            prompt is for yearly filers; sales are covered by the line above. */}
        {euPurchasesDetected && !euSalesDetected && vatRegistered && momsPeriod === 'yearly' && !hasEuTrade && (
          <SignalLine
            text={t('eu_purchase_suggestion_title')}
            help={t('eu_purchase_suggestion_help')}
          />
        )}

        {/* The VAT sub-block. The reveal keeps the fields mounted while
            hidden (inert): the handleSave gates on vat_registered in
            TaxSettingsContent make the saved result identical to the old
            unmount behavior. */}
        <SettingsReveal open={vatRegistered} indent>
          <SettingsRow
            label={t('vat_number_label')}
            htmlFor="vat_number"
            help={t('vat_number_help')}
            align="baseline"
          >
            <SettingsInput
              id="vat_number"
              name="vat_number"
              placeholder="SE123456789001"
              defaultValue={settings.vat_number || ''}
            />
          </SettingsRow>

          <SettingsRow
            label={t('moms_period_label')}
            htmlFor="moms_period"
            help={t('moms_period_help')}
          >
            <SettingsSelect
              id="moms_period"
              name="moms_period"
              value={momsPeriod}
              onChange={(e) => setMomsPeriod(e.target.value)}
            >
              <option value="" disabled>
                {t('select_period_placeholder')}
              </option>
              <option value="monthly">{t('period_monthly')}</option>
              <option value="quarterly" disabled={vatTaxableBaseOver40m}>
                {t('period_quarterly')}
              </option>
              <option value="yearly" disabled={vatTaxableBaseOver40m}>
                {t('period_yearly')}
              </option>
            </SettingsSelect>
          </SettingsRow>

          <SettingsRow
            label={t('vat_taxable_base_over_40m_label')}
            htmlFor="vat_taxable_base_over_40m"
            help={t('vat_taxable_base_over_40m_help')}
          >
            <Switch
              id="vat_taxable_base_over_40m"
              checked={vatTaxableBaseOver40m}
              onCheckedChange={(value) => {
                const checked = value === true
                setVatTaxableBaseOver40m(checked)
                // Over 40 MSEK forces monthly VAT reporting.
                if (checked) setMomsPeriod('monthly')
              }}
            />
            <input
              type="hidden"
              name="vat_taxable_base_over_40m"
              value={vatTaxableBaseOver40m ? 'true' : 'false'}
            />
          </SettingsRow>

          <SettingsRow
            label={t('vat_has_eu_trade_label')}
            htmlFor="vat_has_eu_trade"
            help={t('vat_has_eu_trade_help')}
            borderless={hasEuTrade}
          >
            <Switch
              id="vat_has_eu_trade"
              checked={hasEuTrade}
              onCheckedChange={(value) => {
                const checked = value === true
                setHasEuTrade(checked)
                // No EU trade means no periodisk sammanställning.
                if (!checked) setPsEnabled(false)
              }}
            />
            <input type="hidden" name="vat_has_eu_trade" value={hasEuTrade ? 'true' : 'false'} />
          </SettingsRow>

          {momsPeriod === 'yearly' && !hasEuTrade && !isEnskildFirma && (
            <SettingsRow
              label={t('vat_filing_method_label')}
              htmlFor="vat_filing_method"
              help={t('vat_filing_method_help')}
              borderless
            >
              <SettingsSelect
                id="vat_filing_method"
                name="vat_filing_method"
                defaultValue={settings.vat_filing_method || 'electronic'}
              >
                <option value="electronic">{t('filing_method_electronic')}</option>
                <option value="paper">{t('filing_method_paper')}</option>
              </SettingsSelect>
            </SettingsRow>
          )}

          <SettingsReveal open={hasEuTrade}>
            <SettingsRow
              label={t('periodisk_enabled_label')}
              htmlFor="periodisk_sammanstallning_enabled"
              help={t('periodisk_enabled_help')}
              borderless={psEnabled}
            >
              <Switch
                id="periodisk_sammanstallning_enabled"
                checked={psEnabled}
                onCheckedChange={(value) => setPsEnabled(value === true)}
              />
              <input
                type="hidden"
                name="periodisk_sammanstallning_enabled"
                value={psEnabled ? 'true' : 'false'}
              />
            </SettingsRow>

            <SettingsReveal open={psEnabled}>
              <SettingsRow
                label={t('periodisk_label')}
                htmlFor="periodisk_sammanstallning_period"
                help={t('periodisk_help')}
              >
                <SettingsSelect
                  id="periodisk_sammanstallning_period"
                  name="periodisk_sammanstallning_period"
                  defaultValue={settings.periodisk_sammanstallning_period || 'monthly'}
                >
                  <option value="monthly">{t('period_monthly')}</option>
                  <option value="quarterly">{t('period_quarterly')}</option>
                </SettingsSelect>
              </SettingsRow>

              <SettingsRow
                label={t('periodisk_filing_method_label')}
                htmlFor="periodisk_sammanstallning_filing_method"
                help={t('periodisk_filing_method_help')}
                borderless
              >
                <SettingsSelect
                  id="periodisk_sammanstallning_filing_method"
                  name="periodisk_sammanstallning_filing_method"
                  defaultValue={settings.periodisk_sammanstallning_filing_method || 'electronic'}
                >
                  <option value="electronic">{t('filing_method_electronic')}</option>
                  <option value="paper">{t('filing_method_paper')}</option>
                </SettingsSelect>
              </SettingsRow>
            </SettingsReveal>
          </SettingsReveal>
        </SettingsReveal>
      </SettingsGroup>

      {/* Tax contact: required for SKV filings. */}
      <SettingsGroup label={t('tax_contact_heading')} help={t('tax_contact_help')}>
        <SettingsRow label={t('tax_contact_name_label')} htmlFor="tax_contact_name" align="baseline">
          <SettingsInput
            id="tax_contact_name"
            name="tax_contact_name"
            defaultValue={settings.tax_contact_name || ''}
            placeholder={t('tax_contact_name_placeholder')}
          />
        </SettingsRow>
        <SettingsRow label={t('tax_contact_phone_label')} htmlFor="tax_contact_phone" align="baseline">
          <SettingsInput
            id="tax_contact_phone"
            name="tax_contact_phone"
            defaultValue={settings.tax_contact_phone || ''}
            placeholder="08-123 45 67"
          />
        </SettingsRow>
        <SettingsRow label={t('tax_contact_email_label')} htmlFor="tax_contact_email" align="baseline">
          <SettingsInput
            id="tax_contact_email"
            name="tax_contact_email"
            type="email"
            defaultValue={settings.tax_contact_email || ''}
            placeholder="anna@foretaget.se"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Fiscal year & salaries */}
      {/* Kontrolluppgifter (KU) */}
      <SettingsGroup label={t('kontrolluppgifter_heading')}>
        {kuTriggers.length > 0 && !kuEnabled && (
          <SignalLine
            text={kuTriggers
              .map((trigger) =>
                trigger.kind === 'owner_loan_interest'
                  ? t('ku_suggestion_interest', {
                      amount: formatAmount(trigger.amount),
                      year: trigger.year,
                      interest_accounts: trigger.interest_accounts.join(', '),
                      loan_accounts: trigger.loan_accounts.join(', '),
                    })
                  : t('ku_suggestion_dividend', { amount: formatAmount(trigger.amount) }),
              )
              .join(' ')}
            help={t('ku_suggestion_help')}
          />
        )}

        <SettingsRow
          label={t('kontrolluppgifter_label')}
          htmlFor="kontrolluppgifter_enabled"
          help={t('kontrolluppgifter_help')}
        >
          <Switch
            id="kontrolluppgifter_enabled"
            checked={kuEnabled}
            onCheckedChange={(v) => setKuEnabled(v === true)}
          />
          <input
            type="hidden"
            name="kontrolluppgifter_enabled"
            value={kuEnabled ? 'true' : 'false'}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* ROT/RUT */}
      <SettingsGroup label={t('rot_rut_heading')}>
        {rotRutSignalDetected && !rotRutEnabled && (
          <SignalLine text={t('rot_rut_suggestion_title')} help={t('rot_rut_suggestion_help')} />
        )}

        <SettingsRow
          label={t('rot_rut_label')}
          htmlFor="rot_rut_enabled"
          help={t('rot_rut_help')}
        >
          <Switch
            id="rot_rut_enabled"
            checked={rotRutEnabled}
            onCheckedChange={(v) => setRotRutEnabled(v === true)}
          />
          <input
            type="hidden"
            name="rot_rut_enabled"
            value={rotRutEnabled ? 'true' : 'false'}
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Preliminary tax */}
      <SettingsGroup label={t('preliminary_tax_heading')}>
        <SettingsRow
          label={t('preliminary_tax_monthly_label')}
          htmlFor="preliminary_tax_monthly"
          help={t('preliminary_tax_monthly_help')}
          align="baseline"
        >
          <SettingsInput
            id="preliminary_tax_monthly"
            name="preliminary_tax_monthly"
            type="number"
            defaultValue={settings.preliminary_tax_monthly || ''}
            className="max-w-32 flex-none tabular-nums"
          />
        </SettingsRow>
        <SettingsRow
          label={t('preliminary_tax_first_due_date_label')}
          htmlFor="preliminary_tax_first_due_date"
          help={t('preliminary_tax_first_due_date_help')}
          align="baseline"
        >
          <SettingsInput
            id="preliminary_tax_first_due_date"
            name="preliminary_tax_first_due_date"
            type="date"
            defaultValue={settings.preliminary_tax_first_due_date || ''}
            className="max-w-44 flex-none tabular-nums"
          />
        </SettingsRow>
      </SettingsGroup>

      {/* Long-tail deadlines: explicit opt-in only */}
      <SettingsGroup label={t('more_deadlines_heading')} help={t('more_deadlines_help')}>
        {vatRegistered && (
          <>
            <SettingsRow label={t('oss_label')} htmlFor="oss_enabled" help={t('oss_help')}>
              <Switch
                id="oss_enabled"
                checked={ossEnabled}
                onCheckedChange={(v) => setOssEnabled(v === true)}
              />
              <input type="hidden" name="oss_enabled" value={ossEnabled ? 'true' : 'false'} />
            </SettingsRow>

            <SettingsRow label={t('ioss_label')} htmlFor="ioss_enabled" help={t('ioss_help')}>
              <Switch
                id="ioss_enabled"
                checked={iossEnabled}
                onCheckedChange={(v) => setIossEnabled(v === true)}
              />
              <input type="hidden" name="ioss_enabled" value={iossEnabled ? 'true' : 'false'} />
            </SettingsRow>

            <SettingsRow label={t('intrastat_label')} htmlFor="intrastat_enabled" help={t('intrastat_help')}>
              <Switch
                id="intrastat_enabled"
                checked={intrastatEnabled}
                onCheckedChange={(v) => setIntrastatEnabled(v === true)}
              />
              <input
                type="hidden"
                name="intrastat_enabled"
                value={intrastatEnabled ? 'true' : 'false'}
              />
            </SettingsRow>
          </>
        )}

        <SettingsRow label={t('punktskatt_label')} htmlFor="punktskatt_enabled" help={t('punktskatt_help')}>
          <Switch
            id="punktskatt_enabled"
            checked={punktskattEnabled}
            onCheckedChange={(v) => setPunktskattEnabled(v === true)}
          />
          <input
            type="hidden"
            name="punktskatt_enabled"
            value={punktskattEnabled ? 'true' : 'false'}
          />
        </SettingsRow>

        <SettingsRow
          label={t('fyllnadsinbetalning_label')}
          htmlFor="fyllnadsinbetalning_enabled"
          help={t('fyllnadsinbetalning_help')}
        >
          <Switch
            id="fyllnadsinbetalning_enabled"
            checked={fyllnadEnabled}
            onCheckedChange={(v) => setFyllnadEnabled(v === true)}
          />
          <input
            type="hidden"
            name="fyllnadsinbetalning_enabled"
            value={fyllnadEnabled ? 'true' : 'false'}
          />
        </SettingsRow>
      </SettingsGroup>
    </div>
  )
}
