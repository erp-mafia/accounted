'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  SettingsGroup,
  SettingsInput,
  SettingsReveal,
  SettingsRow,
  SettingsSelect,
} from '@/components/settings/SettingsRows'
import type { CompanySettings } from '@/types'

interface TaxSettingsFormProps {
  settings: CompanySettings
  /** Ledger-derived signal: EU sales postings exist (3108/3308/3107). */
  euSalesDetected?: boolean
  /** Ledger-derived signal: utdelning/ägarlån postings exist (2898/2393/2893). */
  kuSignalDetected?: boolean
  /** Invoice-derived signal: invoices with ROT/RUT deductions exist. */
  rotRutSignalDetected?: boolean
}

/**
 * Ledger/invoice-derived suggestion (EU sales, KU, ROT/RUT) as one visible
 * warning-tone sentence. The full body, including the legal deadlines and
 * late-fee amounts, lives behind the "?" so the signal stays a single line.
 */
function SignalLine({ text, help }: { text: string; help: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 border-b border-border px-1 py-3 text-[12.5px] leading-relaxed text-attn">
      <span>{text}</span>
      <HelpPopover className="shrink-0">{help}</HelpPopover>
    </p>
  )
}

export function TaxSettingsForm({
  settings,
  euSalesDetected = false,
  kuSignalDetected = false,
  rotRutSignalDetected = false,
}: TaxSettingsFormProps) {
  const t = useTranslations('settings_tax_form')
  const [vatRegistered, setVatRegistered] = useState(settings.vat_registered ?? false)
  const [fSkatt, setFSkatt] = useState(settings.f_skatt ?? true)
  const [paysSalaries, setPaysSalaries] = useState(settings.pays_salaries ?? false)
  // Fall back to pays_salaries for rows saved before the registration flag
  // existed; saving attests the shown value.
  const [employerRegistered, setEmployerRegistered] = useState(
    settings.employer_registered ?? settings.pays_salaries ?? false,
  )
  const [employerSeasonal, setEmployerSeasonal] = useState(settings.employer_seasonal ?? false)
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

  const months = [
    t('month_jan'), t('month_feb'), t('month_mar'), t('month_apr'),
    t('month_may'), t('month_jun'), t('month_jul'), t('month_aug'),
    t('month_sep'), t('month_oct'), t('month_nov'), t('month_dec'),
  ]

  return (
    <div>
      <SettingsGroup label={t('tax_vat_heading')}>
        {/* Entity type: read-only. Changing it is a support operation. */}
        <SettingsRow label={t('entity_form_heading')} help={t('entity_form_help')}>
          <span className="text-sm">
            {settings.entity_type === 'aktiebolag' ? t('entity_aktiebolag') : t('entity_enskild_firma')}
          </span>
        </SettingsRow>

        <SettingsRow label={t('f_skatt_label')} htmlFor="f_skatt" help={t('f_skatt_help')}>
          <Switch
            id="f_skatt"
            checked={fSkatt}
            onCheckedChange={(v) => setFSkatt(v === true)}
          />
          <input type="hidden" name="f_skatt" value={fSkatt ? 'true' : 'false'} />
        </SettingsRow>

        <SettingsRow
          label={t('vat_registered_label')}
          htmlFor="vat_registered"
          help={t('vat_registered_help')}
          borderless={vatRegistered}
        >
          <Switch
            id="vat_registered"
            checked={vatRegistered}
            onCheckedChange={(value) => {
              const checked = value === true
              setVatRegistered(checked)
              if (checked && vatTaxableBaseOver40m) setMomsPeriod('monthly')
            }}
          />
          <input type="hidden" name="vat_registered" value={vatRegistered ? 'true' : 'false'} />
        </SettingsRow>

        {euSalesDetected && vatRegistered && (!hasEuTrade || !psEnabled) && (
          <SignalLine
            text={t('eu_trade_suggestion_title')}
            help={t('eu_trade_suggestion_help')}
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
      <SettingsGroup label={t('fiscal_year_salaries_heading')}>
        <SettingsRow
          label={t('fiscal_year_start_label')}
          htmlFor="fiscal_year_start_month"
          help={isEnskildFirma ? t('fiscal_year_ef_help') : t('fiscal_year_change_help')}
        >
          {isEnskildFirma ? (
            <>
              <SettingsInput
                id="fiscal_year_start_month"
                value={t('month_jan')}
                disabled
                className="max-w-32 flex-none"
              />
              <input type="hidden" name="fiscal_year_start_month" value="1" />
            </>
          ) : (
            <SettingsSelect
              id="fiscal_year_start_month"
              name="fiscal_year_start_month"
              defaultValue={String(settings.fiscal_year_start_month || 1)}
            >
              {months.map((month, i) => (
                <option key={i + 1} value={String(i + 1)}>{month}</option>
              ))}
            </SettingsSelect>
          )}
        </SettingsRow>

        <SettingsRow label={t('pays_salaries_label')} htmlFor="pays_salaries" help={t('pays_salaries_help')}>
          <Switch
            id="pays_salaries"
            checked={paysSalaries}
            onCheckedChange={(v) => {
              const checked = v === true
              setPaysSalaries(checked)
              // Paying out salary obliges employer registration (SFL 7 kap. 1 §).
              if (checked) setEmployerRegistered(true)
            }}
          />
          <input type="hidden" name="pays_salaries" value={paysSalaries ? 'true' : 'false'} />
        </SettingsRow>

        <SettingsRow
          label={t('employer_registered_label')}
          htmlFor="employer_registered"
          help={t('employer_registered_help')}
          borderless={employerRegistered}
        >
          <Switch
            id="employer_registered"
            checked={employerRegistered}
            onCheckedChange={(v) => {
              const checked = v === true
              setEmployerRegistered(checked)
              if (!checked) setEmployerSeasonal(false)
            }}
          />
          <input
            type="hidden"
            name="employer_registered"
            value={employerRegistered ? 'true' : 'false'}
          />
        </SettingsRow>

        <SettingsReveal open={employerRegistered}>
          <SettingsRow
            label={t('employer_seasonal_label')}
            htmlFor="employer_seasonal"
            help={t('employer_seasonal_help')}
            borderless
          >
            <Switch
              id="employer_seasonal"
              checked={employerSeasonal}
              onCheckedChange={(v) => setEmployerSeasonal(v === true)}
            />
            <input
              type="hidden"
              name="employer_seasonal"
              value={employerSeasonal ? 'true' : 'false'}
            />
          </SettingsRow>
        </SettingsReveal>
      </SettingsGroup>

      {/* Kontrolluppgifter (KU) */}
      <SettingsGroup label={t('kontrolluppgifter_heading')}>
        {kuSignalDetected && !kuEnabled && (
          <SignalLine text={t('ku_suggestion_title')} help={t('ku_suggestion_help')} />
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
