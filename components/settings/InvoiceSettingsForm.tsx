'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { CompanySettings } from '@/types'

interface InvoiceSettingsFormProps {
  settings: CompanySettings
}

export function InvoiceSettingsForm({ settings }: InvoiceSettingsFormProps) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Fakturainställningar
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end">
        <div className="space-y-2">
          <Label htmlFor="invoice_prefix">Fakturaprefix</Label>
          <Input
            id="invoice_prefix"
            name="invoice_prefix"
            placeholder="t.ex. F-"
            defaultValue={settings.invoice_prefix || ''}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="next_invoice_number">Nästa fakturanummer</Label>
          <Input
            id="next_invoice_number"
            name="next_invoice_number"
            type="number"
            min="1"
            defaultValue={settings.next_invoice_number || 1}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="invoice_default_days">Betalningsvillkor (dagar)</Label>
          <Input
            id="invoice_default_days"
            name="invoice_default_days"
            type="number"
            min="0"
            defaultValue={settings.invoice_default_days || 30}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="invoice_default_notes">Standardtext på fakturor</Label>
        <Textarea
          id="invoice_default_notes"
          name="invoice_default_notes"
          rows={3}
          placeholder="T.ex. betalningsvillkor, leveransinfo..."
          defaultValue={settings.invoice_default_notes || ''}
        />
        <p className="text-xs text-muted-foreground">
          Föreslås automatiskt vid ny faktura.
        </p>
      </div>
    </section>
  )
}
