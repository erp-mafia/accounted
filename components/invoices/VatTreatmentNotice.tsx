'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn } from '@/lib/utils'
import {
  explainVatTreatment,
  type InvoiceVatWarning,
  type VatTreatmentCustomer,
} from '@/lib/invoices/vat-rules'
import type { VatValidationResult } from '@/types'

/**
 * The one sentence that says why an invoice gets the VAT treatment it gets
 * (#2749, #2558), with the fix inline: the VIES check for an EU customer
 * whose number is not validated, the customer card when there is no number
 * or the country blocks reverse charge, the draft when a Swedish rate sits
 * on a reverse-charge or export invoice.
 *
 * Renders explainVatTreatment() verbatim in the viewer's language: the same
 * text the MCP approval card and the API responses carry, so nothing here
 * composes its own version of the rule. Renders nothing when there is
 * nothing to explain.
 *
 * `tone` follows the page: 'attn' is the page's single ochre sentence
 * (design convention 6); 'muted' where another line already holds that
 * role, such as the invoice editor whose ochre line is the next step.
 */
interface VatTreatmentNoticeProps {
  customer: VatTreatmentCustomer
  /** Effective rates of the priced lines (text rows excluded). */
  lineVatRates: number[]
  /**
   * Fired after a successful one-click VIES check. /api/vat/validate has
   * already stamped vat_number_validated on the customer row; the caller
   * mirrors that in whatever local copy it renders from.
   */
  onValidated?: (result: { vat_number: string; name?: string }) => void
  /** Where "edit the draft" goes when a Swedish rate sits on a foreign-business invoice. */
  editHref?: string
  tone?: 'attn' | 'muted'
  className?: string
}

export function pickVatWarningMessage(warning: InvoiceVatWarning, locale: string): string {
  return locale === 'en' ? warning.message_en : warning.message_sv
}

export function VatTreatmentNotice({
  customer,
  lineVatRates,
  onValidated,
  editHref,
  tone = 'attn',
  className,
}: VatTreatmentNoticeProps) {
  const t = useTranslations('vat_treatment_notice')
  const locale = useLocale()
  const { toast } = useToast()
  const [isValidating, setIsValidating] = useState(false)

  const warning = explainVatTreatment(customer, lineVatRates)[0]
  if (!warning) return null

  async function validateVatNumber() {
    if (!customer.id || !customer.vat_number || isValidating) return
    setIsValidating(true)
    try {
      const response = await fetch('/api/vat/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vat_number: customer.vat_number, customer_id: customer.id }),
      })
      const result = (await response.json()) as VatValidationResult | { error: unknown }
      if (!response.ok) {
        toast({
          title: t('error_title'),
          description: getErrorMessage(result, { statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      const validation = result as VatValidationResult
      if (!validation.valid) {
        toast({
          title: t('invalid_title'),
          description: validation.error || t('invalid_default'),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: t('validated_title'),
        description: validation.name
          ? t('validated_description', { name: validation.name })
          : t('validated_description_no_name'),
      })
      onValidated?.({
        vat_number: validation.vat_number ?? customer.vat_number,
        name: validation.name,
      })
    } catch {
      toast({ title: t('error_title'), description: t('error_description'), variant: 'destructive' })
    } finally {
      setIsValidating(false)
    }
  }

  const action = (() => {
    switch (warning.code) {
      case 'EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED':
        if (customer.id && customer.vat_number && onValidated) {
          return { label: isValidating ? t('validating') : t('validate_action'), onClick: () => void validateVatNumber() }
        }
        return customer.id ? { label: t('open_customer_action'), href: `/customers/${customer.id}` } : undefined
      case 'EU_BUSINESS_VAT_NUMBER_MISSING':
      case 'EU_BUSINESS_COUNTRY_IS_SE':
        return customer.id ? { label: t('open_customer_action'), href: `/customers/${customer.id}` } : undefined
      case 'SWEDISH_VAT_TO_REVERSE_CHARGE_CUSTOMER':
      case 'SWEDISH_VAT_TO_EXPORT_CUSTOMER':
        return editHref ? { label: t('edit_draft_action'), href: editHref } : undefined
      default:
        return undefined
    }
  })()

  return (
    <AttnLine
      action={action}
      className={cn(tone === 'muted' && 'text-muted-foreground', className)}
    >
      {pickVatWarningMessage(warning, locale)}
    </AttnLine>
  )
}
