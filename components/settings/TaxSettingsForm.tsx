'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CompanySettings } from '@/types'

interface TaxSettingsFormProps {
  settings: CompanySettings
}

export function TaxSettingsForm({ settings }: TaxSettingsFormProps) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Preliminärskatt
      </h2>

      <div className="max-w-xs space-y-2">
        <Label htmlFor="preliminary_tax_monthly">
          Månatlig preliminärskatt (F-skatt)
        </Label>
        <Input
          id="preliminary_tax_monthly"
          name="preliminary_tax_monthly"
          type="number"
          defaultValue={settings.preliminary_tax_monthly || ''}
        />
        <p className="text-xs text-muted-foreground">
          Belopp i SEK som betalas varje månad.
        </p>
      </div>
    </section>
  )
}
