'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CompanySettings } from '@/types'

interface CompanyInfoFormProps {
  settings: CompanySettings
}

export function CompanyInfoForm({ settings }: CompanyInfoFormProps) {
  const t = useTranslations('settings_company')
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('company_info_heading')}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="company_name">{t('company_name_label')}</Label>
          <Input
            id="company_name"
            name="company_name"
            defaultValue={settings.company_name || ''}
          />
          <p className="text-xs text-muted-foreground">
            {t('company_name_help')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="org_number">{t('org_number_label')}</Label>
          <Input
            id="org_number"
            name="org_number"
            defaultValue={settings.org_number || ''}
            disabled={settings.onboarding_complete === true}
          />
          {settings.onboarding_complete && (
            <p className="text-xs text-muted-foreground">{t('org_number_locked')}</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="address_line1">{t('address_label')}</Label>
        <Input
          id="address_line1"
          name="address_line1"
          defaultValue={settings.address_line1 || ''}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="postal_code">{t('postal_code_label')}</Label>
          <Input
            id="postal_code"
            name="postal_code"
            defaultValue={settings.postal_code || ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="city">{t('city_label')}</Label>
          <Input
            id="city"
            name="city"
            defaultValue={settings.city || ''}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="phone">{t('phone_label')}</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={settings.phone || ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">{t('email_label')}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={settings.email || ''}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="website">{t('website_label')}</Label>
        <Input
          id="website"
          name="website"
          defaultValue={settings.website || ''}
          placeholder="https://"
        />
      </div>
    </section>
  )
}
