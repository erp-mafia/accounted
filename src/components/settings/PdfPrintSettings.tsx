'use client'

import { useTranslations, useLocale } from 'next-intl'
import { useState, useCallback, useRef, type ChangeEvent } from 'react'
import { ArrowUpTrayIcon, SpinnerIcon, TrashIcon } from '@/components/icons'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { useSaveSettings } from '@/components/settings/use-save-settings'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSelect,
  SettingsTextarea,
} from '@/components/settings/SettingsRows'
import { INVOICE_FONT_FAMILIES } from '@/lib/invoices/branding-constants'
import { getErrorMessage as getUserErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
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
  | 'invoice_show_article_number'

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
  const errorLocale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const saveSettings = useSaveSettings()
  const [lateFeeText, setLateFeeText] = useState(settings.invoice_late_fee_text || '')
  const [creditTermsText, setCreditTermsText] = useState(settings.invoice_credit_terms_text || '')
  const [lateFeeTextEn, setLateFeeTextEn] = useState(settings.invoice_late_fee_text_en || '')
  const [creditTermsTextEn, setCreditTermsTextEn] = useState(settings.invoice_credit_terms_text_en || '')
  const [isSavingFont, setIsSavingFont] = useState(false)
  const [isUploadingFont, setIsUploadingFont] = useState(false)
  const [isDeletingFont, setIsDeletingFont] = useState(false)
  const fontInputRef = useRef<HTMLInputElement>(null)

  // Every save shows the server's reason on a refusal (useSaveSettings);
  // these used to show a bare "could not save", and the font save rendered
  // the error envelope as "[object Object]".
  const failedTitle = t('toast_save_failed')
  const saveToggle = useCallback(async (field: string, value: boolean) => {
    const update = { [field]: value } as Partial<CompanySettings>
    if (await saveSettings(update, { failedTitle })) onUpdate(update)
  }, [onUpdate, saveSettings, failedTitle])

  const saveQrMode = useCallback(async (mode: InvoiceQrMode) => {
    if (await saveSettings({ invoice_qr_mode: mode }, { failedTitle })) onUpdate({ invoice_qr_mode: mode })
  }, [onUpdate, saveSettings, failedTitle])

  const saveText = useCallback(async (field: string, value: string) => {
    const update = { [field]: value || null } as Partial<CompanySettings>
    if (await saveSettings(update, { failedTitle })) onUpdate(update)
  }, [onUpdate, saveSettings, failedTitle])

  // The English fine print saves only a change, so tabbing through an
  // empty field writes nothing (crm#1735).
  const saveEnglishText = useCallback(
    (field: 'invoice_late_fee_text_en' | 'invoice_credit_terms_text_en', value: string) => {
      if (value !== (settings[field] ?? '')) void saveText(field, value)
    },
    [settings, saveText],
  )

  const saveFont = useCallback(async (fontFamily: InvoiceFontFamily) => {
    setIsSavingFont(true)
    if (await saveSettings({ invoice_font_family: fontFamily }, { failedTitle })) {
      onUpdate({ invoice_font_family: fontFamily })
    }
    setIsSavingFont(false)
  }, [onUpdate, saveSettings, failedTitle])

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
      if (!response.ok) throw new Error(getUserErrorMessage(result, { locale: errorLocale, fallback: t('font_upload_failed') }))
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
      if (!response.ok) throw new Error(getUserErrorMessage(result, { locale: errorLocale, fallback: t('font_delete_failed') }))
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
    {
      field: 'invoice_show_article_number',
      label: t('show_article_number_label'),
      help: t('show_article_number_help'),
      defaultOn: false,
    },
    // No company-name switch or placement: the fixed layout always prints the
    // legal name in Från and the footer (and in the logo slot without a
    // logo). The columns stay for API compatibility (DECISIONS 2026-10-02).
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
              <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUpTrayIcon className="h-3.5 w-3.5" />
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
                <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <TrashIcon className="h-3.5 w-3.5" />
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
        label={t('late_fee_en_label')}
        htmlFor="invoice_late_fee_text_en"
        help={t('fine_print_en_help')}
        align="baseline"
      >
        <SettingsTextarea
          id="invoice_late_fee_text_en"
          rows={2}
          placeholder={t('fine_print_en_placeholder')}
          value={lateFeeTextEn}
          onChange={(e) => setLateFeeTextEn(e.target.value)}
          onBlur={() => saveEnglishText('invoice_late_fee_text_en', lateFeeTextEn)}
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
      <SettingsRow
        label={t('credit_terms_en_label')}
        htmlFor="invoice_credit_terms_text_en"
        help={t('fine_print_en_help')}
        align="baseline"
      >
        <SettingsTextarea
          id="invoice_credit_terms_text_en"
          rows={2}
          placeholder={t('fine_print_en_placeholder')}
          value={creditTermsTextEn}
          onChange={(e) => setCreditTermsTextEn(e.target.value)}
          onBlur={() => saveEnglishText('invoice_credit_terms_text_en', creditTermsTextEn)}
        />
      </SettingsRow>
    </SettingsGroup>
  )
}
