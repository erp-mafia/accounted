'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { AutoGrowTextarea } from '@/components/invoices/AutoGrowTextarea'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/use-toast'
import { QrModeRadioGroup } from '@/components/settings/PdfPrintSettings'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { EditorSection } from './EditorSection'
import { INVOICE_QR_MODES, type CompanySettings, type InvoiceQrMode } from '@/types'

export type PaymentPanelScope = 'all' | 'this'

/** "Som alla fakturor": the invoice inherits the company's QR choice. */
const INHERIT = 'inherit'

type ShowField = 'invoice_show_bankgiro' | 'invoice_show_plusgiro' | 'invoice_show_ocr' | 'invoice_show_swish'

interface PaymentPanelProps {
  scope: PaymentPanelScope
  onScopeChange: (scope: PaymentPanelScope) => void
  /** Owner/admin with write access: the "Alla fakturor" scope writes company settings. */
  canEditCompany: boolean
  settings: CompanySettings
  /** The numbers the chosen payee prints (the company default or this invoice's account). */
  printed: { bankgiro: string | null; plusgiro: string | null; swish: string | null; bankAccount: string | null }
  /** Patch the cached settings and refresh the preview after a save. */
  onSettingsSaved: (updates: Partial<CompanySettings>) => void
  /** This invoice's own QR choice; null = as all invoices. */
  invoiceQrMode: InvoiceQrMode | null
  onInvoiceQrModeChange: (mode: InvoiceQrMode | null) => void
  /** Why a mode prints no code on this invoice (one short line), or null when it prints. */
  qrReasonFor: (mode: InvoiceQrMode) => string | null
  /** Betalas till: the payee select, when there is a choice. */
  payeeField: ReactNode | null
  /** The invoice's own payment link field, when payment links are on. */
  paymentLinkField: ReactNode | null
  onClose: () => void
}

const ROW_CLASS = 'flex items-center justify-between gap-4 border-b border-border py-3 text-[13px]'

// A text that grows with its content, in the form field look.
const TEXT_FIELD_CLASS =
  'w-full rounded-lg border border-input bg-card px-4 py-2 text-[13px] transition-colors duration-150 placeholder:text-muted-foreground/60 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20'

/**
 * "Betalning och utseende": what the Betalning summary's "Ändra" opens in
 * place of the form, while the PDF stays live on the right. Two scopes:
 *
 *  - Alla fakturor (owner/admin): the company's print switches, QR choice
 *    and terms texts, saved through PUT /api/settings like the settings
 *    page's Utskrift & PDF.
 *  - Bara den här: only what an invoice can carry on its own, the QR code
 *    (invoices.qr_mode) and the account it is paid to (Betalas till), plus
 *    its payment link.
 */
export function PaymentPanel({
  scope,
  onScopeChange,
  canEditCompany,
  settings,
  printed,
  onSettingsSaved,
  invoiceQrMode,
  onInvoiceQrModeChange,
  qrReasonFor,
  payeeField,
  paymentLinkField,
  onClose,
}: PaymentPanelProps) {
  const t = useTranslations('invoice_editor_panel')
  const tPdf = useTranslations('settings_pdf_print')
  const { toast } = useToast()
  const [creditTerms, setCreditTerms] = useState(settings.invoice_credit_terms_text ?? '')
  const [lateFee, setLateFee] = useState(settings.invoice_late_fee_text ?? '')
  const effectiveScope: PaymentPanelScope = canEditCompany ? scope : 'this'
  // The panel takes the column's place: start at its top, wherever the form was scrolled.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    rootRef.current?.scrollIntoView({ block: 'start' })
  }, [])

  async function save(updates: Partial<CompanySettings>) {
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!response.ok) throw new Error()
      onSettingsSaved(updates)
    } catch {
      toast({ title: tPdf('toast_save_failed'), variant: 'destructive' })
    }
  }

  const showRows: Array<{ field: ShowField; label: string; value: string | null; hint?: string; defaultOn: boolean }> = [
    ...(printed.bankgiro
      ? [{ field: 'invoice_show_bankgiro' as const, label: t('show_bankgiro'), value: printed.bankgiro, defaultOn: true }]
      : []),
    ...(printed.plusgiro
      ? [{ field: 'invoice_show_plusgiro' as const, label: t('show_plusgiro'), value: printed.plusgiro, defaultOn: true }]
      : []),
    ...(printed.bankgiro || printed.plusgiro
      ? [{ field: 'invoice_show_ocr' as const, label: t('show_ocr'), value: null, hint: t('show_ocr_hint'), defaultOn: true }]
      : []),
    ...(printed.swish
      ? [{ field: 'invoice_show_swish' as const, label: t('show_swish'), value: printed.swish, defaultOn: false }]
      : []),
  ]

  const companyMode: InvoiceQrMode = settings.invoice_qr_mode ?? 'auto'
  const companyModeLabel = tPdf(`qr_mode_${companyMode}`)
  const invoiceQrOptions = [
    { value: INHERIT, label: t('qr_inherit', { mode: companyModeLabel }), hint: t('qr_inherit_hint') },
    // The company's own mode is what "as all invoices" already gives: listed
    // again only when this invoice stores it explicitly.
    ...INVOICE_QR_MODES.filter((mode) => mode !== companyMode || invoiceQrMode === mode).map((mode) => ({
      value: mode as string,
      label: tPdf(`qr_mode_${mode}`),
      hint: qrReasonFor(mode) ?? tPdf(`qr_mode_${mode}_hint`),
    })),
  ]
  const companyQrOptions = INVOICE_QR_MODES.map((mode) => ({
    value: mode,
    label: tPdf(`qr_mode_${mode}`),
    hint: tPdf(`qr_mode_${mode}_hint`),
  }))

  return (
    <div ref={rootRef} className="scroll-mt-6 space-y-8">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose} className="-ml-2">
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('back')}
        </Button>
        <h2 className="font-display text-[15px]">{t('title')}</h2>
        {canEditCompany && (
          <SegmentedControl
            className="ml-auto"
            aria-label={t('scope_aria')}
            value={scope}
            onChange={onScopeChange}
            options={[
              { value: 'all', label: t('scope_all') },
              { value: 'this', label: t('scope_this') },
            ]}
          />
        )}
      </div>

      {effectiveScope === 'all' ? (
        <>
          <EditorSection label={t('section_printed')}>
            {/* The bank account always prints when it is set: no switch. */}
            {printed.bankAccount && (
              <div className={ROW_CLASS}>
                <span>{t('show_bank_account')}</span>
                <span className="tabular-nums text-muted-foreground">{printed.bankAccount}</span>
              </div>
            )}
            {showRows.length > 0 ? (
              showRows.map((row) => (
                <div key={row.field} className={ROW_CLASS}>
                  <div className="min-w-0">
                    <Label htmlFor={`panel-${row.field}`} className="text-[13px] font-normal">
                      {row.label}
                    </Label>
                    {row.hint && <p className="text-[12.5px] text-muted-foreground">{row.hint}</p>}
                  </div>
                  <div className="flex items-center gap-4">
                    {row.value && <span className="tabular-nums text-muted-foreground">{row.value}</span>}
                    <Switch
                      id={`panel-${row.field}`}
                      checked={settings[row.field] ?? row.defaultOn}
                      onCheckedChange={(value) => void save({ [row.field]: value })}
                    />
                  </div>
                </div>
              ))
            ) : null}
            <Link href="/settings/invoicing" className={`${QUIET_LINK_CLASS} mt-3 inline-block`}>
              {t('accounts_link')}
            </Link>
          </EditorSection>

          <EditorSection label={tPdf('qr_mode_label')} aside={t('qr_one_per_invoice')}>
            <QrModeRadioGroup
              value={settings.invoice_qr_mode ?? 'auto'}
              onChange={(mode) => void save({ invoice_qr_mode: mode })}
              options={companyQrOptions}
              label={tPdf('qr_mode_label')}
            />
          </EditorSection>

          <EditorSection label={t('section_terms')}>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="panel-credit-terms" className="text-[13px] font-normal">
                  {t('credit_terms_label')}
                </Label>
                <AutoGrowTextarea
                  id="panel-credit-terms"
                  className={TEXT_FIELD_CLASS}
                  placeholder={tPdf('credit_terms_placeholder')}
                  value={creditTerms}
                  onChange={(event) => setCreditTerms(event.target.value)}
                  onBlur={() => {
                    if (creditTerms !== (settings.invoice_credit_terms_text ?? '')) {
                      void save({ invoice_credit_terms_text: creditTerms || null })
                    }
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="panel-late-fee" className="text-[13px] font-normal">
                  {tPdf('late_fee_label')}
                </Label>
                <AutoGrowTextarea
                  id="panel-late-fee"
                  className={TEXT_FIELD_CLASS}
                  placeholder={tPdf('late_fee_placeholder')}
                  value={lateFee}
                  onChange={(event) => setLateFee(event.target.value)}
                  onBlur={() => {
                    if (lateFee !== (settings.invoice_late_fee_text ?? '')) {
                      void save({ invoice_late_fee_text: lateFee || null })
                    }
                  }}
                />
              </div>
            </div>
          </EditorSection>

          <EditorSection label={t('section_appearance')}>
            <div className={ROW_CLASS}>
              <span>{t('appearance_label')}</span>
              <Link href="/settings/invoicing" className={QUIET_LINK_CLASS}>
                {t('appearance_link')}
              </Link>
            </div>
          </EditorSection>
        </>
      ) : (
        <>
          {!canEditCompany && <p className="text-[12.5px] text-muted-foreground">{t('member_note')}</p>}
          {payeeField && <EditorSection label={t('section_payee')}>{payeeField}</EditorSection>}
          <EditorSection label={tPdf('qr_mode_label')} aside={t('qr_one_per_invoice')}>
            <QrModeRadioGroup<string>
              value={invoiceQrMode ?? INHERIT}
              onChange={(value) => onInvoiceQrModeChange(value === INHERIT ? null : (value as InvoiceQrMode))}
              options={invoiceQrOptions}
              label={tPdf('qr_mode_label')}
            />
          </EditorSection>
          {paymentLinkField && <EditorSection label={t('section_payment_link')}>{paymentLinkField}</EditorSection>}
        </>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {t('done')}
        </Button>
      </div>
    </div>
  )
}
