'use client'

import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CompanySettings } from '@/types'

interface TaxSettingsFormProps {
  settings: CompanySettings
  /** Ledger-derived signal: EU sales postings exist (3108/3308/3107). */
  euSalesDetected?: boolean
}

export function TaxSettingsForm({ settings, euSalesDetected = false }: TaxSettingsFormProps) {
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

  const isEnskildFirma = settings.entity_type === 'enskild_firma'

  const months = [
    t('month_jan'), t('month_feb'), t('month_mar'), t('month_apr'),
    t('month_may'), t('month_jun'), t('month_jul'), t('month_aug'),
    t('month_sep'), t('month_oct'), t('month_nov'), t('month_dec'),
  ]

  return (
    <div className="space-y-8">
      {/* Entity type: read-only */}
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('entity_form_heading')}
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">
            {settings.entity_type === 'aktiebolag' ? t('entity_aktiebolag') : t('entity_enskild_firma')}
          </span>
          <p className="text-xs text-muted-foreground">
            {t('entity_form_help')}
          </p>
        </div>
      </section>

      {/* F-skatt */}
      <section className="border-t border-border pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('tax_vat_heading')}
        </h2>

        <div className="space-y-4">
          <div className="flex items-start space-x-3">
            <Checkbox
              id="f_skatt"
              checked={fSkatt}
              onCheckedChange={(v) => setFSkatt(v === true)}
            />
            <input type="hidden" name="f_skatt" value={fSkatt ? 'true' : 'false'} />
            <div className="space-y-1">
              <Label htmlFor="f_skatt" className="cursor-pointer">{t('f_skatt_label')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('f_skatt_help')}
              </p>
            </div>
          </div>

          <div className="flex items-start space-x-3">
            <Checkbox
              id="vat_registered"
              checked={vatRegistered}
              onCheckedChange={(value) => {
                const checked = value === true
                setVatRegistered(checked)
                if (checked && vatTaxableBaseOver40m) setMomsPeriod('monthly')
              }}
            />
            <input type="hidden" name="vat_registered" value={vatRegistered ? 'true' : 'false'} />
            <div className="space-y-1">
              <Label htmlFor="vat_registered" className="cursor-pointer">{t('vat_registered_label')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('vat_registered_help')}
              </p>
            </div>
          </div>

          {euSalesDetected && vatRegistered && (!hasEuTrade || !psEnabled) && (
            <div className="rounded-lg border border-border p-4">
              <p className="text-sm">{t('eu_trade_suggestion_title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('eu_trade_suggestion_help')}
              </p>
            </div>
          )}

          {vatRegistered && (
            <div className="space-y-4 pl-7">
              <div className="max-w-xs space-y-2">
                <Label htmlFor="vat_number">{t('vat_number_label')}</Label>
                <Input
                  id="vat_number"
                  name="vat_number"
                  placeholder="SE123456789001"
                  defaultValue={settings.vat_number || ''}
                />
                <p className="text-xs text-muted-foreground">
                  {t('vat_number_help')}
                </p>
              </div>

              <div className="max-w-xs space-y-2">
                <Label>{t('moms_period_label')}</Label>
                <Select
                  name="moms_period"
                  value={momsPeriod || undefined}
                  onValueChange={setMomsPeriod}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('select_period_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">{t('period_monthly')}</SelectItem>
                    <SelectItem value="quarterly" disabled={vatTaxableBaseOver40m}>
                      {t('period_quarterly')}
                    </SelectItem>
                    <SelectItem value="yearly" disabled={vatTaxableBaseOver40m}>
                      {t('period_yearly')}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('moms_period_help')}
                </p>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="vat_taxable_base_over_40m"
                  checked={vatTaxableBaseOver40m}
                  onCheckedChange={(value) => {
                    const checked = value === true
                    setVatTaxableBaseOver40m(checked)
                    if (checked) setMomsPeriod('monthly')
                  }}
                />
                <input
                  type="hidden"
                  name="vat_taxable_base_over_40m"
                  value={vatTaxableBaseOver40m ? 'true' : 'false'}
                />
                <div className="space-y-1">
                  <Label htmlFor="vat_taxable_base_over_40m" className="cursor-pointer">
                    {t('vat_taxable_base_over_40m_label')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('vat_taxable_base_over_40m_help')}
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="vat_has_eu_trade"
                  checked={hasEuTrade}
                  onCheckedChange={(value) => {
                    const checked = value === true
                    setHasEuTrade(checked)
                    if (!checked) setPsEnabled(false)
                  }}
                />
                <input type="hidden" name="vat_has_eu_trade" value={hasEuTrade ? 'true' : 'false'} />
                <div className="space-y-1">
                  <Label htmlFor="vat_has_eu_trade" className="cursor-pointer">
                    {t('vat_has_eu_trade_label')}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {t('vat_has_eu_trade_help')}
                  </p>
                </div>
              </div>

              {momsPeriod === 'yearly' && !hasEuTrade && !isEnskildFirma && (
                <div className="max-w-xs space-y-2">
                  <Label>{t('vat_filing_method_label')}</Label>
                  <Select
                    name="vat_filing_method"
                    defaultValue={settings.vat_filing_method || 'electronic'}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="electronic">{t('filing_method_electronic')}</SelectItem>
                      <SelectItem value="paper">{t('filing_method_paper')}</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">{t('vat_filing_method_help')}</p>
                </div>
              )}

              {hasEuTrade && (
                <div className="space-y-4">
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="periodisk_sammanstallning_enabled"
                      checked={psEnabled}
                      onCheckedChange={(value) => setPsEnabled(value === true)}
                    />
                    <input
                      type="hidden"
                      name="periodisk_sammanstallning_enabled"
                      value={psEnabled ? 'true' : 'false'}
                    />
                    <div className="space-y-1">
                      <Label htmlFor="periodisk_sammanstallning_enabled" className="cursor-pointer">
                        {t('periodisk_enabled_label')}
                      </Label>
                      <p className="text-xs text-muted-foreground">{t('periodisk_enabled_help')}</p>
                    </div>
                  </div>

                  {psEnabled && (
                    <div className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>{t('periodisk_label')}</Label>
                        <Select
                          name="periodisk_sammanstallning_period"
                          defaultValue={settings.periodisk_sammanstallning_period || 'monthly'}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="monthly">{t('period_monthly')}</SelectItem>
                            <SelectItem value="quarterly">{t('period_quarterly')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">{t('periodisk_help')}</p>
                      </div>

                      <div className="space-y-2">
                        <Label>{t('periodisk_filing_method_label')}</Label>
                        <Select
                          name="periodisk_sammanstallning_filing_method"
                          defaultValue={settings.periodisk_sammanstallning_filing_method || 'electronic'}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="electronic">{t('filing_method_electronic')}</SelectItem>
                            <SelectItem value="paper">{t('filing_method_paper')}</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-muted-foreground">
                          {t('periodisk_filing_method_help')}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </section>

      {/* Tax contact: required for SKV-filings */}
      <section className="border-t border-border pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('tax_contact_heading')}
        </h2>
        <p className="text-xs text-muted-foreground -mt-2">
          {t('tax_contact_help')}
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
          <div className="space-y-2">
            <Label htmlFor="tax_contact_name">{t('tax_contact_name_label')}</Label>
            <Input
              id="tax_contact_name"
              name="tax_contact_name"
              defaultValue={settings.tax_contact_name || ''}
              placeholder={t('tax_contact_name_placeholder')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax_contact_phone">{t('tax_contact_phone_label')}</Label>
            <Input
              id="tax_contact_phone"
              name="tax_contact_phone"
              defaultValue={settings.tax_contact_phone || ''}
              placeholder="08-123 45 67"
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="tax_contact_email">{t('tax_contact_email_label')}</Label>
            <Input
              id="tax_contact_email"
              name="tax_contact_email"
              type="email"
              defaultValue={settings.tax_contact_email || ''}
              placeholder="anna@foretaget.se"
            />
          </div>
        </div>
      </section>

      {/* Fiscal year & salaries */}
      <section className="border-t border-border pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('fiscal_year_salaries_heading')}
        </h2>

        <div className="max-w-xs space-y-2">
          <Label>{t('fiscal_year_start_label')}</Label>
          {isEnskildFirma ? (
            <>
              <Input value={t('month_jan')} disabled />
              <input type="hidden" name="fiscal_year_start_month" value="1" />
              <p className="text-xs text-muted-foreground">
                {t('fiscal_year_ef_help')}
              </p>
            </>
          ) : (
            <>
              <Select
                name="fiscal_year_start_month"
                defaultValue={String(settings.fiscal_year_start_month || 1)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {months.map((month, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>{month}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('fiscal_year_change_help')}
              </p>
            </>
          )}
        </div>

        <div className="flex items-start space-x-3">
          <Checkbox
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
          <div className="space-y-1">
            <Label htmlFor="pays_salaries" className="cursor-pointer">{t('pays_salaries_label')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('pays_salaries_help')}
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-3">
          <Checkbox
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
          <div className="space-y-1">
            <Label htmlFor="employer_registered" className="cursor-pointer">
              {t('employer_registered_label')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('employer_registered_help')}
            </p>
          </div>
        </div>

        {employerRegistered && (
          <div className="flex items-start space-x-3 pl-7">
            <Checkbox
              id="employer_seasonal"
              checked={employerSeasonal}
              onCheckedChange={(v) => setEmployerSeasonal(v === true)}
            />
            <input
              type="hidden"
              name="employer_seasonal"
              value={employerSeasonal ? 'true' : 'false'}
            />
            <div className="space-y-1">
              <Label htmlFor="employer_seasonal" className="cursor-pointer">
                {t('employer_seasonal_label')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('employer_seasonal_help')}
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Preliminary tax */}
      <section className="border-t border-border pt-8 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          {t('preliminary_tax_heading')}
        </h2>

        <div className="max-w-xs space-y-2">
          <Label htmlFor="preliminary_tax_monthly">
            {t('preliminary_tax_monthly_label')}
          </Label>
          <Input
            id="preliminary_tax_monthly"
            name="preliminary_tax_monthly"
            type="number"
            defaultValue={settings.preliminary_tax_monthly || ''}
          />
          <p className="text-xs text-muted-foreground">
            {t('preliminary_tax_monthly_help')}
          </p>
        </div>
      </section>
    </div>
  )
}
