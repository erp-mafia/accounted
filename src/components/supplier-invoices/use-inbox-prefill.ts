'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import type { UseFormGetValues, UseFormReset, UseFormSetValue } from 'react-hook-form'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { suggestBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import {
  vatRateFromAi,
  type SupplierInvoiceFormData,
  type SupplierInvoiceLineItem,
} from '@/lib/supplier-invoices/form-payload'
import type { Supplier, InvoiceExtractionResult } from '@/types'

export interface InboxItemData {
  id: string
  extracted_data: InvoiceExtractionResult | null
  matched_supplier_id: string | null
  document_id: string | null
}

interface UseInboxPrefillParams {
  inboxItemId: string | null
  suppliersLoaded: boolean
  suppliers: Supplier[]
  setValue: UseFormSetValue<SupplierInvoiceFormData>
  replace: (items: SupplierInvoiceLineItem[]) => void
  reset: UseFormReset<SupplierInvoiceFormData>
  getValues: UseFormGetValues<SupplierInvoiceFormData>
  toast: ReturnType<typeof useToast>['toast']
  t: ReturnType<typeof useTranslations>
  /** Called for each scalar form field the extraction filled (settle tint hosts). */
  onFieldPrefilled?: (field: string) => void
}

/**
 * The AI-extraction prefill for the supplier-invoice editor. Owns the
 * extraction state (extractedData/originalExtracted, matched supplier flag,
 * loading + one-shot guards) and the effect that loads an inbox item when the
 * form is opened with ?inbox_item_id. `applyInboxItem` is the reusable core:
 * the dokument-först upload flow feeds the same function, so both arrival
 * paths share one prefill semantics (incl. the reset(getValues()) baseline
 * that keeps the unsaved-changes prompt quiet).
 */
export function useInboxPrefill({
  inboxItemId,
  suppliersLoaded,
  suppliers,
  setValue,
  replace,
  reset,
  getValues,
  toast,
  t,
  onFieldPrefilled,
}: UseInboxPrefillParams) {
  const [extractedData, setExtractedData] = useState<InvoiceExtractionResult | null>(null)
  const [originalExtracted, setOriginalExtracted] = useState<InvoiceExtractionResult | null>(null)
  const [hasMatchedSupplier, setHasMatchedSupplier] = useState(false)
  const [isLoadingInbox, setIsLoadingInbox] = useState(!!inboxItemId)
  const [hasPrefilled, setHasPrefilled] = useState(false)
  // Bumped once per applied extraction. Effects that must re-run after every
  // apply (not just the first: a remove + re-upload applies again) depend on
  // this instead of the one-shot `hasPrefilled` flag.
  const [applyCount, setApplyCount] = useState(0)

  // The dokument-forst upload path calls applyInboxItem from long-lived
  // closures (the 90 s extraction poll captures the starting render), so the
  // supplier list is read through a ref: otherwise an extraction that lands
  // after the suppliers finished loading resolves against a stale [] and the
  // matched supplier is silently dropped.
  const suppliersRef = useRef(suppliers)
  useEffect(() => {
    suppliersRef.current = suppliers
  }, [suppliers])

  const applyInboxItem = useCallback(
    (item: InboxItemData): boolean => {
      const extracted = item.extracted_data
      if (!extracted) return false

      setExtractedData(extracted)
      setOriginalExtracted(extracted)

      // Supplier
      if (
        item.matched_supplier_id &&
        suppliersRef.current.find((s) => s.id === item.matched_supplier_id)
      ) {
        setValue('supplier_id', item.matched_supplier_id)
        setHasMatchedSupplier(true)
        onFieldPrefilled?.('supplier_id')
      }

      // Scalar invoice fields
      if (extracted.invoice?.invoiceNumber) {
        setValue('supplier_invoice_number', extracted.invoice.invoiceNumber)
        onFieldPrefilled?.('supplier_invoice_number')
      }
      if (extracted.invoice?.invoiceDate) {
        setValue('invoice_date', extracted.invoice.invoiceDate)
        onFieldPrefilled?.('invoice_date')
      }
      if (extracted.invoice?.dueDate) {
        setValue('due_date', extracted.invoice.dueDate)
        onFieldPrefilled?.('due_date')
      }
      if (extracted.invoice?.paymentReference) {
        setValue('payment_reference', extracted.invoice.paymentReference)
        onFieldPrefilled?.('payment_reference')
      }
      if (extracted.invoice?.currency) {
        setValue('currency', extracted.invoice.currency)
        onFieldPrefilled?.('currency')
      }

      // Line items: keep the single empty default if AI returned nothing,
      // otherwise replace it with the extracted lines. When the document
      // states a service window of 2+ calendar months (insurance period,
      // license term), pre-fill periodisering on every positive line: the
      // user sees the panel and can remove it before booking.
      if (extracted.lineItems && extracted.lineItems.length > 0) {
        // AI-extracted values are untrusted input: only accept strict
        // ISO-8601 dates before they reach form state (and later the API).
        const isIsoDate = (v: unknown): v is string =>
          typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
        const spsRaw = extracted.invoice?.servicePeriodStart
        const speRaw = extracted.invoice?.servicePeriodEnd
        const sps = isIsoDate(spsRaw) ? spsRaw : null
        const spe = isIsoDate(speRaw) ? speRaw : null
        let prefillAccrual = false
        if (sps && spe && spe >= sps) {
          try {
            prefillAccrual = countCalendarMonths(sps, spe) >= 2
          } catch {
            prefillAccrual = false
          }
        }
        replace(
          extracted.lineItems.map((li) => {
            const amount = typeof li.lineTotal === 'number' ? li.lineTotal : 0
            const withAccrual = prefillAccrual && amount > 0
            return {
              description: li.description || '',
              amount,
              // Extraction never suggests accounts (forcibly nulled at parse
              // time) and a silent default misbooks: leave empty so the user
              // (or the supplier default) makes the call.
              account_number: '',
              // Deliberately unconditional: for icke momsregistrerade the
              // zeroing effect grosses the net amount up by this rate
              // before forcing it to 0, so the rate must arrive intact.
              vat_rate: vatRateFromAi(li.vatRate),
              accrual_period_start: withAccrual ? (sps as string) : undefined,
              accrual_period_end: withAccrual ? (spe as string) : undefined,
              // No account yet → generic 1790; toggleAccrual re-suggests the
              // same way once the user picks one.
              accrual_balance_account: withAccrual
                ? suggestBalanceAccount('expense', '')
                : undefined,
            }
          }),
        )
        onFieldPrefilled?.('items')
      }

      // Treat the AI prefill as the new baseline: otherwise the unsaved-
      // changes prompt fires the moment the user navigates away, even if
      // they didn't touch anything.
      reset(getValues())
      setHasPrefilled(true)
      setApplyCount((c) => c + 1)
      return true
    },
    [setValue, replace, reset, getValues, onFieldPrefilled],
  )

  // One-shot: load inbox item and prefill form. Runs after suppliers are
  // loaded so we can resolve matched_supplier_id to a real picker value.
  // Gate on `suppliersLoaded`, not `suppliers.length > 0`: otherwise the
  // effect never fires for users who haven't booked a supplier yet and
  // the "Laddar uppgifter från inkorgen…" spinner sticks forever.
  useEffect(() => {
    if (!inboxItemId || hasPrefilled || !suppliersLoaded) return
    let cancelled = false

    ;(async () => {
      try {
        const res = await fetch(`/api/extensions/ext/invoice-inbox/items/${inboxItemId}`)
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) {
          toast({
            title: t('inbox_load_failed_title'),
            description: json?.error || t('inbox_load_failed_description'),
            variant: 'destructive',
          })
          setIsLoadingInbox(false)
          return
        }

        const item = json.data as InboxItemData
        if (!item.extracted_data) {
          setIsLoadingInbox(false)
          setHasPrefilled(true)
          return
        }

        applyInboxItem(item)
      } catch (err) {
        if (cancelled) return
        toast({
          title: t('inbox_load_failed_title'),
          description: err instanceof Error ? getErrorMessage(err) : t('unknown_error'),
          variant: 'destructive',
        })
      } finally {
        if (!cancelled) setIsLoadingInbox(false)
      }
    })()

    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxItemId, suppliersLoaded, suppliers])

  return {
    extractedData,
    originalExtracted,
    hasMatchedSupplier,
    setHasMatchedSupplier,
    isLoadingInbox,
    hasPrefilled,
    applyCount,
    applyInboxItem,
  }
}
