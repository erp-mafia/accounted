'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CompanySettings } from '@/types'

interface CompanyInfoFormProps {
  settings: CompanySettings
}

export function CompanyInfoForm({ settings }: CompanyInfoFormProps) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Företagsuppgifter
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="company_name">Företagsnamn</Label>
          <Input
            id="company_name"
            name="company_name"
            defaultValue={settings.company_name || ''}
            disabled={settings.onboarding_complete === true}
          />
          {settings.onboarding_complete && (
            <p className="text-xs text-muted-foreground">Kan inte ändras efter att kontot skapats</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="org_number">Organisationsnummer</Label>
          <Input
            id="org_number"
            name="org_number"
            defaultValue={settings.org_number || ''}
            disabled={settings.onboarding_complete === true}
          />
          {settings.onboarding_complete && (
            <p className="text-xs text-muted-foreground">Kan inte ändras efter att kontot skapats</p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="address_line1">Adress</Label>
        <Input
          id="address_line1"
          name="address_line1"
          defaultValue={settings.address_line1 || ''}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="postal_code">Postnummer</Label>
          <Input
            id="postal_code"
            name="postal_code"
            defaultValue={settings.postal_code || ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="city">Ort</Label>
          <Input
            id="city"
            name="city"
            defaultValue={settings.city || ''}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="phone">Telefon</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={settings.phone || ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">E-post</Label>
          <Input
            id="email"
            name="email"
            type="email"
            defaultValue={settings.email || ''}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="website">Webbplats</Label>
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
