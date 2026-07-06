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
}

export function TaxSettingsForm({ settings }: TaxSettingsFormProps) {
  const t = useTranslations('settings_tax_form')
  const [vatRegistered, setVatRegistered] = useState(settings.vat_registered ?? false)
  const [fSkatt, setFSkatt] = useState(settings.f_skatt ?? true)
  const [paysSalaries, setPaysSalaries] = useState(settings.pays_salaries ?? false)

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
              onCheckedChange={(v) => setVatRegistered(v === true)}
            />
            <input type="hidden" name="vat_registered" value={vatRegistered ? 'true' : 'false'} />
            <div className="space-y-1">
              <Label htmlFor="vat_registered" className="cursor-pointer">{t('vat_registered_label')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('vat_registered_help')}
              </p>
            </div>
          </div>

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
                  defaultValue={settings.moms_period || undefined}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('select_period_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">{t('period_monthly')}</SelectItem>
                    <SelectItem value="quarterly">{t('period_quarterly')}</SelectItem>
                    <SelectItem value="yearly">{t('period_yearly')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('moms_period_help')}
                </p>
              </div>

              <div className="max-w-xs space-y-2">
                <Label>{t('periodisk_label')}</Label>
                <Select
                  name="periodisk_sammanstallning_period"
                  defaultValue={settings.periodisk_sammanstallning_period || 'monthly'}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('select_period_placeholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">{t('period_monthly')}</SelectItem>
                    <SelectItem value="quarterly">{t('period_quarterly')}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {t('periodisk_help')}
                </p>
              </div>
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
            onCheckedChange={(v) => setPaysSalaries(v === true)}
          />
          <input type="hidden" name="pays_salaries" value={paysSalaries ? 'true' : 'false'} />
          <div className="space-y-1">
            <Label htmlFor="pays_salaries" className="cursor-pointer">{t('pays_salaries_label')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('pays_salaries_help')}
            </p>
          </div>
        </div>
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
