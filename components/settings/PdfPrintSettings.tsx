'use client'

import { useTranslations } from 'next-intl'
import { useState, useCallback } from 'react'
import { Input } from '@/components/ui/input'
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
  const t = useTranslations('settings_pdf_print')
  const { toast } = useToast()
  const [lateFeeText, setLateFeeText] = useState(settings.invoice_late_fee_text || '')
  const [creditTermsText, setCreditTermsText] = useState(settings.invoice_credit_terms_text || '')
  const [reminderFeeAmount, setReminderFeeAmount] = useState(
    String(settings.reminder_fee_amount ?? 60),
  )
  // Display override as a percentage (the DB stores a decimal). Empty = no override.
  const [interestRatePercent, setInterestRatePercent] = useState(
    settings.reminder_interest_rate_override != null
      ? String(settings.reminder_interest_rate_override * 100)
      : '',
  )

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
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    }
  }, [onUpdate, toast, t])

  const savePosition = useCallback(async (value: 'header' | 'footer') => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_company_name_position: value }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ invoice_company_name_position: value })
    } catch {
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    }
  }, [onUpdate, toast, t])

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
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    }
  }, [onUpdate, toast, t])

  const saveReminderFeeAmount = useCallback(async (raw: string) => {
    const parsed = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(parsed) || parsed < 0) {
      toast({ title: 'Ogiltigt belopp', variant: 'destructive' })
      return
    }
    // Lag 1981:739: maxgräns 60 kr för lagstadgad påminnelseavgift.
    const clamped = Math.min(parsed, 60)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminder_fee_amount: clamped }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ reminder_fee_amount: clamped })
      setReminderFeeAmount(String(clamped))
    } catch {
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    }
  }, [onUpdate, toast, t])

  const saveInterestOverride = useCallback(async (raw: string) => {
    if (raw.trim() === '') {
      try {
        const response = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reminder_interest_rate_override: null }),
        })
        if (!response.ok) throw new Error()
        onUpdate({ reminder_interest_rate_override: null })
      } catch {
        toast({ title: t('toast_save_failed'), variant: 'destructive' })
      }
      return
    }
    const percent = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(percent) || percent < 0 || percent >= 100) {
      toast({ title: 'Ogiltig räntesats (0–99%)', variant: 'destructive' })
      return
    }
    const decimal = Math.round((percent / 100) * 10_000) / 10_000
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminder_interest_rate_override: decimal }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ reminder_interest_rate_override: decimal })
    } catch {
      toast({ title: t('toast_save_failed'), variant: 'destructive' })
    }
  }, [onUpdate, toast, t])

  return (
    <section className="space-y-6">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('heading')}
      </h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <Label>{t('ore_rounding_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('ore_rounding_help')}</p>
          </div>
          <Switch
            checked={settings.ore_rounding ?? true}
            onCheckedChange={(v) => saveToggle('ore_rounding', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>{t('show_ocr_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('show_ocr_help')}</p>
          </div>
          <Switch
            checked={settings.invoice_show_ocr ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_ocr', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>{t('show_bankgiro_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('show_bankgiro_help')}</p>
          </div>
          <Switch
            checked={settings.invoice_show_bankgiro ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_bankgiro', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>{t('show_plusgiro_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('show_plusgiro_help')}</p>
          </div>
          <Switch
            checked={settings.invoice_show_plusgiro ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_plusgiro', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>{t('show_swish_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('show_swish_help')}</p>
          </div>
          <Switch
            checked={settings.invoice_show_swish ?? false}
            onCheckedChange={(v) => saveToggle('invoice_show_swish', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>{t('show_logo_label')}</Label>
            <p className="text-xs text-muted-foreground">{t('show_logo_help')}</p>
          </div>
          <Switch
            checked={settings.invoice_show_logo ?? true}
            onCheckedChange={(v) => saveToggle('invoice_show_logo', v)}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('show_company_name_label')}</Label>
              <p className="text-xs text-muted-foreground">{t('show_company_name_help')}</p>
            </div>
            <Switch
              checked={settings.invoice_show_company_name ?? true}
              onCheckedChange={(v) => saveToggle('invoice_show_company_name', v)}
            />
          </div>
          {(settings.invoice_show_company_name ?? true) && (
            <div className="flex items-center justify-between pl-0">
              <p className="text-xs text-muted-foreground">{t('placement_label')}</p>
              <div
                role="group"
                aria-label={t('placement_aria_label')}
                className="inline-flex rounded-md border border-border/60 p-0.5"
              >
                {(['header', 'footer'] as const).map((pos) => {
                  const active = (settings.invoice_company_name_position ?? 'header') === pos
                  return (
                    <button
                      key={pos}
                      type="button"
                      aria-pressed={active}
                      onClick={() => savePosition(pos)}
                      className={
                        'h-10 px-4 text-sm rounded-sm transition-colors ' +
                        (active
                          ? 'bg-muted text-foreground'
                          : 'text-muted-foreground hover:text-foreground')
                      }
                    >
                      {pos === 'header' ? t('placement_header') : t('placement_footer')}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-4 pt-2">
        <div className="space-y-2">
          <Label htmlFor="invoice_late_fee_text">{t('late_fee_label')}</Label>
          <Textarea
            id="invoice_late_fee_text"
            rows={2}
            placeholder={t('late_fee_placeholder')}
            value={lateFeeText}
            onChange={(e) => setLateFeeText(e.target.value)}
            onBlur={() => saveText('invoice_late_fee_text', lateFeeText)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invoice_credit_terms_text">{t('credit_terms_label')}</Label>
          <Textarea
            id="invoice_credit_terms_text"
            rows={2}
            placeholder={t('credit_terms_placeholder')}
            value={creditTermsText}
            onChange={(e) => setCreditTermsText(e.target.value)}
            onBlur={() => saveText('invoice_credit_terms_text', creditTermsText)}
          />
        </div>
      </div>

      <div className="pt-6 space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Automatisering
        </h2>

        <div className="flex items-center justify-between">
          <div>
            <Label>Skicka automatiska påminnelser</Label>
            <p className="text-xs text-muted-foreground">
              Skicka påminnelser till kunder för försenade fakturor enligt din inställning för påminnelseintervall.
            </p>
          </div>
          <Switch
            checked={settings.send_invoice_reminders ?? true}
            onCheckedChange={(v) => saveToggle('send_invoice_reminders', v)}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Aktivera påminnelseavgift</Label>
            <p className="text-xs text-muted-foreground">
              Debitera lagstadgad påminnelseavgift (Lag 1981:739, max 60 kr) på varje påminnelse.
              Avgiften bokförs automatiskt (1510 / 3990) och adderas till kundens fordran.
            </p>
          </div>
          <Switch
            checked={settings.reminder_fee_enabled ?? true}
            onCheckedChange={(v) => saveToggle('reminder_fee_enabled', v)}
          />
        </div>

        {(settings.reminder_fee_enabled ?? true) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pl-0">
            <div className="space-y-2">
              <Label htmlFor="reminder_fee_amount">Påminnelseavgift (kr)</Label>
              <Input
                id="reminder_fee_amount"
                type="number"
                min={0}
                max={60}
                step={1}
                value={reminderFeeAmount}
                onChange={(e) => setReminderFeeAmount(e.target.value)}
                onBlur={() => saveReminderFeeAmount(reminderFeeAmount)}
              />
              <p className="text-xs text-muted-foreground">
                Standardvärde 60 kr. Maxgräns enligt Lag 1981:739.
              </p>
            </div>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="reminder_interest_rate_override">
            Räntesats för dröjsmålsränta (% per år)
          </Label>
          <Input
            id="reminder_interest_rate_override"
            type="number"
            min={0}
            max={99}
            step={0.1}
            placeholder="Lämna tom för Räntelagen §6 (referensränta + 8 procentenheter)"
            value={interestRatePercent}
            onChange={(e) => setInterestRatePercent(e.target.value)}
            onBlur={() => saveInterestOverride(interestRatePercent)}
          />
          <p className="text-xs text-muted-foreground">
            Om tom används lagstadgad dröjsmålsränta (Räntelagen §6 = Riksbankens
            referensränta + 8 procentenheter). Räntan visas i påminnelsen men bokförs inte.
          </p>
        </div>
      </div>
    </section>
  )
}
