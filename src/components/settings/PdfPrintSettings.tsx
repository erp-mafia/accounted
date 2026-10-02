'use client'

import { useTranslations } from 'next-intl'
import { useState, useCallback, useRef, type ChangeEvent } from 'react'
import { Loader2, Trash2, Upload } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  SettingsGroup,
  SettingsReveal,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSeg,
  SettingsSelect,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { INVOICE_FONT_FAMILIES } from '@/lib/invoices/branding-constants'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import { INVOICE_QR_MODES, type CompanySettings, type InvoiceFontFamily, type InvoiceQrMode } from '@/types'

interface PdfPrintSettingsProps {
  settings: CompanySettings
  onUpdate: (updates: Partial<CompanySettings>) => void
}

type PdfToggleField =
  | 'ore_rounding'
  | 'invoice_show_ocr'
  | 'invoice_show_bankgiro'
  | 'invoice_show_plusgiro'
  | 'invoice_show_swish'
  | 'invoice_show_logo'
  | 'invoice_show_company_name'

/** Compact switch row for the show/hide grid: small label, "?", Switch. */
function PdfToggleRow({
  id,
  label,
  help,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  help?: React.ReactNode
  checked: boolean
  onCheckedChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-1 py-3">
      <span className="flex min-w-0 items-center gap-2">
        <label htmlFor={id} className="truncate text-sm">
          {label}
        </label>
        {help ? <HelpPopover className="shrink-0">{help}</HelpPopover> : null}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

/**
 * The one QR code invoices print (lib/invoices/payment-qr.ts): a radio list
 * with a short hint under each choice. It fills the control column like the
 * other settings controls. Also the invoice editor's "Betalning och
 * utseende" panel, where the per-invoice list adds "as all invoices".
 */
export function QrModeRadioGroup<T extends string = InvoiceQrMode>({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: T
  onChange: (mode: T) => void
  options: Array<{ value: T; label: string; hint: string }>
  label: string
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex w-full flex-col gap-1">
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            data-ph-unmask=""
            className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors duration-150 hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span
              aria-hidden
              className={cn(
                'mt-1 flex h-3 w-3 shrink-0 items-center justify-center rounded-full border transition-colors duration-150',
                checked ? 'border-foreground' : 'border-muted-foreground',
              )}
            >
              {checked && <span className="h-1 w-1 rounded-full bg-foreground" />}
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] text-foreground">{option.label}</span>
              <span className="block text-[12.5px] text-muted-foreground">{option.hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function PdfPrintSettings({ settings, onUpdate }: PdfPrintSettingsProps) {
  const t = useTranslations('settings_pdf_print')
  const { toast } = useToast()
  const [lateFeeText, setLateFeeText] = useState(settings.invoice_late_fee_text || '')
  const [creditTermsText, setCreditTermsText] = useState(settings.invoice_credit_terms_text || '')
  const [isSavingFont, setIsSavingFont] = useState(false)
  const [isUploadingFont, setIsUploadingFont] = useState(false)
  const [isDeletingFont, setIsDeletingFont] = useState(false)
  const fontInputRef = useRef<HTMLInputElement>(null)

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

  const saveQrMode = useCallback(async (mode: InvoiceQrMode) => {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_qr_mode: mode }),
      })
      if (!response.ok) throw new Error()
      onUpdate({ invoice_qr_mode: mode })
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

  const saveFont = useCallback(async (fontFamily: InvoiceFontFamily) => {
    setIsSavingFont(true)
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_font_family: fontFamily }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('toast_save_failed'))
      onUpdate({ invoice_font_family: fontFamily })
    } catch (error) {
      toast({
        title: t('toast_save_failed'),
        description: error instanceof Error ? getUserErrorMessage(error) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsSavingFont(false)
    }
  }, [onUpdate, toast, t])

  async function uploadFont(file: File) {
    setIsUploadingFont(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const response = await fetch('/api/settings/invoice-font', {
        method: 'POST',
        body: formData,
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('font_upload_failed'))
      onUpdate(result.data as Partial<CompanySettings>)
    } catch (error) {
      toast({
        title: t('font_upload_failed'),
        description: error instanceof Error ? getUserErrorMessage(error) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsUploadingFont(false)
      if (fontInputRef.current) fontInputRef.current.value = ''
    }
  }

  async function deleteFont() {
    setIsDeletingFont(true)
    try {
      const response = await fetch('/api/settings/invoice-font', { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('font_delete_failed'))
      onUpdate(result.data as Partial<CompanySettings>)
    } catch (error) {
      toast({
        title: t('font_delete_failed'),
        description: error instanceof Error ? getUserErrorMessage(error) : undefined,
        variant: 'destructive',
      })
    } finally {
      setIsDeletingFont(false)
    }
  }

  function handleFontChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (file) void uploadFont(file)
  }

  const fontLabels: Record<InvoiceFontFamily, string> = {
    Helvetica: t('font_helvetica'),
    'Times-Roman': t('font_times'),
    Courier: t('font_courier'),
    'Source Sans 3': t('font_source_sans'),
    'Source Serif 4': t('font_source_serif'),
    Custom: t('font_custom'),
  }

  const toggleRows: Array<{ field: PdfToggleField; label: string; help: string; defaultOn: boolean }> = [
    { field: 'ore_rounding', label: t('ore_rounding_label'), help: t('ore_rounding_help'), defaultOn: true },
    { field: 'invoice_show_ocr', label: t('show_ocr_label'), help: t('show_ocr_help'), defaultOn: true },
    { field: 'invoice_show_bankgiro', label: t('show_bankgiro_label'), help: t('show_bankgiro_help'), defaultOn: true },
    { field: 'invoice_show_plusgiro', label: t('show_plusgiro_label'), help: t('show_plusgiro_help'), defaultOn: true },
    { field: 'invoice_show_swish', label: t('show_swish_label'), help: t('show_swish_help'), defaultOn: false },
    { field: 'invoice_show_logo', label: t('show_logo_label'), help: t('show_logo_help'), defaultOn: true },
    { field: 'invoice_show_company_name', label: t('show_company_name_label'), help: t('show_company_name_help'), defaultOn: true },
  ]

  const qrModeOptions = INVOICE_QR_MODES.map((mode) => ({
    value: mode,
    label: t(`qr_mode_${mode}`),
    hint: t(`qr_mode_${mode}_hint`),
  }))

  return (
    <SettingsGroup label={t('heading')}>
      <SettingsRow
        label={t('font_label')}
        htmlFor="invoice_font_family"
        help={
          <div className="space-y-2">
            <p>{t('font_help')}</p>
            <p>{t('font_file_help')}</p>
          </div>
        }
      >
        <SettingsSelect
          id="invoice_font_family"
          value={settings.invoice_font_family ?? 'Helvetica'}
          onChange={(event) => {
            if (event.target.value) void saveFont(event.target.value as InvoiceFontFamily)
          }}
          disabled={isSavingFont || isUploadingFont || isDeletingFont}
        >
          {INVOICE_FONT_FAMILIES
            .filter((family) => family !== 'Custom' || settings.invoice_custom_font_path)
            .map((family) => (
              <option key={family} value={family}>
                {fontLabels[family]}
              </option>
            ))}
        </SettingsSelect>
        {settings.invoice_custom_font_name && (
          <SettingsRowNote>
            {t('font_uploaded_name', { name: settings.invoice_custom_font_name })}
          </SettingsRowNote>
        )}
        <SettingsRowEnd>
          <button
            type="button"
            onClick={() => fontInputRef.current?.click()}
            disabled={isUploadingFont || isDeletingFont}
            className="inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isUploadingFont ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {settings.invoice_custom_font_path ? t('font_replace') : t('font_upload')}
          </button>
          {settings.invoice_custom_font_path && (
            <button
              type="button"
              onClick={() => void deleteFont()}
              disabled={isUploadingFont || isDeletingFont}
              className="inline-flex items-center gap-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isDeletingFont ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t('font_remove')}
            </button>
          )}
        </SettingsRowEnd>
        <input
          ref={fontInputRef}
          type="file"
          accept=".ttf,.woff,font/ttf,font/woff"
          className="hidden"
          onChange={handleFontChange}
        />
      </SettingsRow>

      {/* Show/hide switches: compact two-column grid of small switch rows. */}
      <div className="grid gap-x-8 md:grid-cols-2">
        {toggleRows.map(({ field, label, help, defaultOn }) => (
          <PdfToggleRow
            key={field}
            id={`pdf-toggle-${field}`}
            label={label}
            help={help}
            checked={settings[field] ?? defaultOn}
            onCheckedChange={(v) => void saveToggle(field, v)}
          />
        ))}
      </div>

      {/* Placement only applies while the company name is shown. */}
      <SettingsReveal open={settings.invoice_show_company_name ?? true}>
        <SettingsRow label={t('placement_label')} borderless>
          <SettingsSeg
            value={settings.invoice_company_name_position ?? 'header'}
            onChange={(pos) => void savePosition(pos)}
            options={[
              { value: 'header', label: t('placement_header') },
              { value: 'footer', label: t('placement_footer') },
            ]}
            aria-label={t('placement_aria_label')}
          />
        </SettingsRow>
      </SettingsReveal>

      <SettingsRow label={t('qr_mode_label')} help={t('qr_mode_help')} align="baseline">
        <QrModeRadioGroup
          value={settings.invoice_qr_mode ?? 'auto'}
          onChange={(mode) => void saveQrMode(mode)}
          options={qrModeOptions}
          label={t('qr_mode_label')}
        />
      </SettingsRow>

      <SettingsRow label={t('late_fee_label')} htmlFor="invoice_late_fee_text" align="baseline">
        <SettingsTextarea
          id="invoice_late_fee_text"
          rows={2}
          placeholder={t('late_fee_placeholder')}
          value={lateFeeText}
          onChange={(e) => setLateFeeText(e.target.value)}
          onBlur={() => saveText('invoice_late_fee_text', lateFeeText)}
        />
      </SettingsRow>
      <SettingsRow
        label={t('credit_terms_label')}
        htmlFor="invoice_credit_terms_text"
        align="baseline"
      >
        <SettingsTextarea
          id="invoice_credit_terms_text"
          rows={2}
          placeholder={t('credit_terms_placeholder')}
          value={creditTermsText}
          onChange={(e) => setCreditTermsText(e.target.value)}
          onBlur={() => saveText('invoice_credit_terms_text', creditTermsText)}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
