'use client'

import { useState, useCallback } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import type { CompanySettings } from '@/types'

interface PdfPrintSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

export function PdfPrintSettings({ settings, onUpdate }: PdfPrintSettingsProps) {
  const { toast } = useToast()
  const [lateFeeText, setLateFeeText] = useState(settings.invoice_late_fee_text || '')
  const [creditTermsText, setCreditTermsText] = useState(settings.invoice_credit_terms_text || '')

  const saveToggle = useCallback(async (field: string, value: boolean) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ [field]: value } as Partial<CompanySettings>)
    } catch {
      toast({ title: 'Kunde inte spara', variant: 'destructive' })
    }
  }, [onUpdate, toast])

  const saveText = useCallback(async (field: string, value: string) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value || null }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ [field]: value || null } as Partial<CompanySettings>)
    } catch {
      toast({ title: 'Kunde inte spara', variant: 'destructive' })
    }
  }, [onUpdate, toast])

  return (
    <section className="space-y-6">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Utskrift & PDF
      </h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label>Öresavrundning</Label>
            <p className="text-xs text-muted-foreground">Avrunda fakturatotal till hel krona</p>
          </div>
          <Switch
            checked={settings.ore_rounding ?? true}
            onCheckedChange={(v) => saveToggle('ore_rounding', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa OCR-referens</Label>
            <p className="text-xs text-muted-foreground">Visa OCR-nummer på fakturautskrift</p>
          </div>
          <Switch
            checked={settings.invoice_show_ocr ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_ocr', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa bankgiro</Label>
            <p className="text-xs text-muted-foreground">Visa bankgironummer på fakturautskrift</p>
          </div>
          <Switch
            checked={settings.invoice_show_bankgiro ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_bankgiro', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Visa plusgiro</Label>
            <p className="text-xs text-muted-foreground">Visa plusgironummer på fakturautskrift</p>
          </div>
          <Switch
            checked={settings.invoice_show_plusgiro ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_plusgiro', v)}
          />
        </div>
      </div>

      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <Label htmlFor="invoice_late_fee_text">Dröjsmålsränta</Label>
          <Textarea
            id="invoice_late_fee_text"
            rows={2}
            placeholder="T.ex. Vid betalning efter förfallodagen debiteras ränta enligt räntelagen."
            value={lateFeeText}
            onChange={(e) => setLateFeeText(e.target.value)}
            onBlur={() => saveText('invoice_late_fee_text', lateFeeText)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice_credit_terms_text">Betalningsvillkor (fotnot)</Label>
          <Textarea
            id="invoice_credit_terms_text"
            rows={2}
            placeholder="T.ex. Betalning sker till angivet bankgiro."
            value={creditTermsText}
            onChange={(e) => setCreditTermsText(e.target.value)}
            onBlur={() => saveText('invoice_credit_terms_text', creditTermsText)}
          />
        </div>
      </div>
    </section>
  )
}
