'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import type { UseFormGetValues, UseFormReset, UseFormSetValue } from 'react-hook-form'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { accountNameForRow } from '@/lib/bookkeeping/account-descriptions'
import { suggestExpenseBalanceAccount } from '@/lib/bookkeeping/accruals/account-suggestions'
import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import { accrualWorthOpening, K2_ACCRUAL_THRESHOLD_SEK } from '@/components/bookkeeping/accrual-k2-hint'
import type { SupplierInvoiceFormData, SupplierInvoiceLineItem } from '@/lib/supplier-invoices/form-payload'
import {
  accountCarriedFrom,
  reverseChargeRateCarriedFrom,
  rowsFromReading,
  rowsStandAsPut,
  type ReadingRow,
  type ReadingRows,
} from '@/lib/supplier-invoices/reading-rows'
import { isForeignSupplierType } from '@/lib/vat/supplier-invoice-line-checks'
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
  /**
   * Replaces the kontering rows with the reading's. `filledNet` is the amount
   * of a single row the total-first fill owns (it follows Fakturabelopp, Moms
   * and the sats), null for rows that stand as read.
   */
  replace: (items: SupplierInvoiceLineItem[], filledNet: number | null) => void
  reset: UseFormReset<SupplierInvoiceFormData>
  getValues: UseFormGetValues<SupplierInvoiceFormData>
  toast: ReturnType<typeof useToast>['toast']
  t: ReturnType<typeof useTranslations>
  /** Called for each scalar form field the extraction filled (settle tint hosts). */
  onFieldPrefilled?: (field: string) => void
  /**
   * The total the document bills (its Att betala), for the editor's
   * Fakturabelopp: what switches öresavrundning on when the lines' total
   * rounds to it. Every arrival path gets it, the inbox item as well as the
   * upload (crm#1595).
   */
  onInvoiceTotal?: (total: number) => void
  /**
   * The moms the document states, for the editor's Moms field beside
   * Fakturabelopp; null clears a figure an earlier reading left there.
   */
  onInvoiceVat?: (vat: number | null) => void
  /**
   * The cost account every row of the reading starts on (the Inkorg's
   * booking plan: the account of what was bought). Without it a row's
   * account stays empty for the person or the supplier default.
   */
  prefillAccount?: string | null
  /**
   * Whether the company is momsregistrerad: one that is not books the
   * invoice's whole total as the cost (rowsFromReading).
   */
  vatRegistered?: boolean
  /**
   * Whether the form stands under reverse charge, as watched: the reading's
   * rows are proposed for it, and again when it is switched after the
   * reading (a foreign supplier picked later switches it on).
   */
  reverseCharge?: boolean
  /**
   * The kontering rows on screen, as watched: the reading's other rows are
   * offered only while these are still exactly what the reading put there.
   */
  items?: SupplierInvoiceLineItem[]
  /** The company's own chart: names a row whose read lines had no text. */
  accounts?: AccountChart
  /**
   * The accrual limit for the fiscal year an invoice date is booked in
   * (K2 7 000 kr from a year starting 2026, 5 000 kr before; null under K3,
   * which has none): a line below it does not open its periodisering on its
   * own.
   */
  accrualThresholdFor?: (invoiceDate: string | null) => number | null
}

type AccountChart = NonNullable<Parameters<typeof accountNameForRow>[1]>

const NO_ROWS: SupplierInvoiceLineItem[] = []
const NO_ACCOUNTS: AccountChart = []

/** How the editor treats the invoice a reading describes: decides its rows (rowsFromReading). */
interface ReadingTreatment {
  vatRegistered: boolean
  reverseCharge: boolean
}

interface ReadingRowsOptions {
  /** The accrual limit for an invoice date (UseInboxPrefillParams.accrualThresholdFor). */
  thresholdFor: UseInboxPrefillParams['accrualThresholdFor']
  /** The account each row starts on. */
  accountFor: (row: ReadingRow, index: number) => string
  /** The company's own chart, for the text of a row whose read lines had none. */
  chart: AccountChart
  /**
   * The reverse-charge sats a row starts with under reverse charge, when the
   * rows it replaces carry one for its moms sats (reverseChargeRateCarriedFrom).
   */
  reverseChargeRateFor?: (row: ReadingRow) => number | undefined
}

/**
 * The form rows for the rows a reading proposes: each on its account, a row
 * whose read lines had no text named after that account, and periodisering
 * where the document states a service window of 2+ calendar months, on
 * every positive row at or above K2's limit for its fiscal year (below it a
 * post need not be accrued, K2 2.4 as amended by BFNAR 2025:2): the user
 * sees the panel and can remove it before booking. None under reverse
 * charge, where the editor clears it: the cost row is the momsunderlag.
 */
function formRowsOf(
  rows: ReadingRow[],
  extracted: InvoiceExtractionResult,
  reverseCharge: boolean,
  { thresholdFor, accountFor, chart, reverseChargeRateFor }: ReadingRowsOptions,
): SupplierInvoiceLineItem[] {
  // AI-extracted values are untrusted input: only accept strict
  // ISO-8601 dates before they reach form state (and later the API).
  const isIsoDate = (v: unknown): v is string =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const spsRaw = extracted.invoice?.servicePeriodStart
  const speRaw = extracted.invoice?.servicePeriodEnd
  const sps = isIsoDate(spsRaw) ? spsRaw : null
  const spe = isIsoDate(speRaw) ? speRaw : null
  let prefillAccrual = false
  if (!reverseCharge && sps && spe && spe >= sps) {
    try {
      prefillAccrual = countCalendarMonths(sps, spe) >= 2
    } catch {
      prefillAccrual = false
    }
  }
  const thresholdSek = thresholdFor
    ? thresholdFor(extracted.invoice?.invoiceDate ?? null)
    : K2_ACCRUAL_THRESHOLD_SEK
  return rows.map((row, index) => {
    const { amount } = row
    const account = accountFor(row, index)
    const reverseChargeRate = reverseCharge ? reverseChargeRateFor?.(row) : undefined
    const withAccrual =
      prefillAccrual && amount > 0 && accrualWorthOpening({ amount, currency: extracted.invoice?.currency, thresholdSek })
    return {
      description: row.description || accountNameForRow(account, chart),
      amount,
      // Extraction never suggests accounts (forcibly nulled at parse
      // time) and a silent default misbooks: leave empty so the user
      // (or the supplier default) makes the call, unless the Inkorg's
      // plan names the account of what was bought.
      account_number: account,
      // The sats as the reading proposes it. For icke momsregistrerade
      // the rows arrive with their moms already in the cost, at 0 %,
      // except under reverse charge: there they keep the sats they were
      // read with, and the editor's zeroing effect grosses them up by it,
      // as it does on main.
      vat_rate: row.vat_rate,
      accrual_period_start: withAccrual ? (sps as string) : undefined,
      accrual_period_end: withAccrual ? (spe as string) : undefined,
      // No account yet → generic 1790, or 2990 when the stated period
      // lies wholly before the invoice month (upplupen kostnad).
      accrual_balance_account: withAccrual
        ? suggestExpenseBalanceAccount(account, spe, extracted.invoice?.invoiceDate)
        : undefined,
      // The sats the editor's own cell gave the rows this one replaces: a
      // row put after reverse charge was switched on then self-assesses as
      // one put before it does.
      ...(reverseChargeRate == null ? {} : { reverse_charge_rate: reverseChargeRate }),
    }
  })
}

/**
 * The form rows a reading puts in the editor under a treatment: its own
 * lines when `split` is asked for and the reading offers them, else the rows
 * it opens with. `lineCount` is null when the reading offers no split.
 * `proposed` is rowsFromReading for this reading and treatment, for a caller
 * that already holds it.
 */
export function readingFormRows(
  extracted: InvoiceExtractionResult,
  treatment: ReadingTreatment,
  split: boolean,
  options: ReadingRowsOptions,
  proposed: ReadingRows = rowsFromReading(extracted, treatment),
) {
  const lines = split ? proposed.invoiceRows : null
  return {
    rows: formRowsOf(lines ?? proposed.rows, extracted, treatment.reverseCharge, options),
    filledNet: lines ? null : proposed.filledNet,
    split: lines != null,
    lineCount: proposed.invoiceRows?.length ?? null,
  }
}

/** The rows a reading last put in the form, and whether they are its own lines. */
interface PutRows {
  rows: SupplierInvoiceLineItem[]
  split: boolean
}

/** Whether the rows on screen are still what the reading put there (rowsStandAsPut). */
function standAsPut(onScreen: SupplierInvoiceLineItem[], put: PutRows, chart: AccountChart, vatRegistered: boolean): boolean {
  return rowsStandAsPut(onScreen, put.rows, (account) => accountNameForRow(account, chart), vatRegistered)
}

/**
 * The rows to put when the treatment changes after a reading (a foreign
 * supplier picked later switches reverse charge on): the reading proposed
 * again for the new treatment, on the accounts the rows on screen have, so
 * the form shows the same rows whichever came first. Null when the person
 * has changed the rows: they stand as they are.
 */
export function readingRowsForNewTreatment(
  extracted: InvoiceExtractionResult,
  treatment: ReadingTreatment,
  put: PutRows,
  onScreen: SupplierInvoiceLineItem[],
  { prefillAccount, ...options }: Omit<ReadingRowsOptions, 'accountFor'> & { prefillAccount: string | null },
) {
  if (!standAsPut(onScreen, put, options.chart, treatment.vatRegistered)) return null
  return readingFormRows(extracted, treatment, put.split, {
    ...options,
    accountFor: accountCarriedFrom(onScreen, prefillAccount),
    reverseChargeRateFor: reverseChargeRateCarriedFrom(onScreen),
  })
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
  onInvoiceTotal,
  onInvoiceVat,
  prefillAccount = null,
  vatRegistered = true,
  reverseCharge = false,
  items = NO_ROWS,
  accounts = NO_ACCOUNTS,
  accrualThresholdFor,
}: UseInboxPrefillParams) {
  const [extractedData, setExtractedData] = useState<InvoiceExtractionResult | null>(null)
  const [originalExtracted, setOriginalExtracted] = useState<InvoiceExtractionResult | null>(null)
  const [hasMatchedSupplier, setHasMatchedSupplier] = useState(false)
  const [isLoadingInbox, setIsLoadingInbox] = useState(!!inboxItemId)
  const [hasPrefilled, setHasPrefilled] = useState(false)
  // Bumped once per applied extraction, and whenever a reading's rows are put
  // in the form again (a split, a changed treatment). Effects that must
  // re-run after every apply (not just the first: a remove + re-upload
  // applies again) depend on this instead of the one-shot `hasPrefilled` flag.
  const [applyCount, setApplyCount] = useState(0)
  // The rows the applied reading last put in the form, and whether they are
  // its own lines (split) or the rows it opens with; null while none are.
  const [put, setPut] = useState<PutRows | null>(null)
  // The treatment those rows were proposed under, for the effect that
  // proposes them again when it changes.
  const putTreatmentRef = useRef<ReadingTreatment | null>(null)

  // The dokument-forst upload path calls applyInboxItem from long-lived
  // closures (the 90 s extraction poll captures the starting render), so the
  // supplier list is read through a ref: otherwise an extraction that lands
  // after the suppliers finished loading resolves against a stale [] and the
  // matched supplier is silently dropped.
  const suppliersRef = useRef(suppliers)
  useEffect(() => {
    suppliersRef.current = suppliers
  }, [suppliers])
  // Read the same way: the limit depends on the fiscal periods, which load on their own.
  const accrualThresholdRef = useRef(accrualThresholdFor)
  useEffect(() => {
    accrualThresholdRef.current = accrualThresholdFor
  }, [accrualThresholdFor])
  // And the same way: the settings row can revalidate while a reading is on its way.
  const vatRegisteredRef = useRef(vatRegistered)
  useEffect(() => {
    vatRegisteredRef.current = vatRegistered
  }, [vatRegistered])
  // And the chart, which loads on its own.
  const accountsRef = useRef(accounts)
  useEffect(() => {
    accountsRef.current = accounts
  }, [accounts])

  // The one way a reading's rows reach the form: replaces the rows and
  // remembers them, so a later swap can tell whether the person changed any.
  const putRows = useCallback(
    (next: ReturnType<typeof readingFormRows>, treatment: ReadingTreatment) => {
      putTreatmentRef.current = treatment
      replace(next.rows, next.filledNet)
      setPut({ rows: next.rows, split: next.split })
      // The rows are the reading's again: effects that follow every apply re-run.
      setApplyCount((c) => c + 1)
    },
    [replace],
  )

  const applyInboxItem = useCallback(
    (item: InboxItemData): boolean => {
      const extracted = item.extracted_data
      if (!extracted) return false

      setExtractedData(extracted)
      setOriginalExtracted(extracted)

      // Supplier
      const supplierBefore = getValues('supplier_id')
      const matched = item.matched_supplier_id
        ? suppliersRef.current.find((s) => s.id === item.matched_supplier_id)
        : undefined
      if (matched) {
        setValue('supplier_id', matched.id)
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

      // Rows: keep what the form has if the reading proposes none, otherwise
      // replace it with the reading's rows, one per moms sats
      // (rowsFromReading), and hand Fakturabelopp and Moms the invoice's own
      // figures. The treatment is the one the form stands under once this
      // reading is in: reverse charge is on already, or the supplier the
      // reading selects is foreign and the form switches it on a render
      // later. Proposed for anything else, the row would be the total-first
      // fill's, and reverse charge would rewrite it to the whole
      // Fakturabelopp.
      const treatment = {
        vatRegistered: vatRegisteredRef.current,
        reverseCharge:
          getValues('reverse_charge') === true ||
          (!!matched && matched.id !== supplierBefore && isForeignSupplierType(matched.supplier_type)),
      }
      const proposed = rowsFromReading(extracted, treatment)
      const opening = readingFormRows(
        extracted,
        treatment,
        false,
        { thresholdFor: accrualThresholdRef.current, accountFor: () => prefillAccount ?? '', chart: accountsRef.current },
        proposed,
      )
      if (opening.rows.length > 0) {
        putRows(opening, treatment)
        onFieldPrefilled?.('items')
      } else {
        setPut(null)
      }
      if (proposed.invoiceTotal != null) onInvoiceTotal?.(proposed.invoiceTotal)
      if (proposed.invoiceTotal != null || proposed.invoiceVat != null) onInvoiceVat?.(proposed.invoiceVat)

      // Treat the AI prefill as the new baseline: otherwise the unsaved-
      // changes prompt fires the moment the user navigates away, even if
      // they didn't touch anything.
      reset(getValues())
      setHasPrefilled(true)
      setApplyCount((c) => c + 1)
      return true
    },
    [setValue, putRows, reset, getValues, onFieldPrefilled, onInvoiceTotal, onInvoiceVat, prefillAccount],
  )

  // The invoice's own lines are a choice beside the rows the reading opens
  // with only where the reading offers them under the treatment the form
  // stands in, and only while nothing on screen would be lost by the swap:
  // the rows are still what the reading put there (rowsStandAsPut).
  const lineCount = useMemo(
    () => (extractedData ? rowsFromReading(extractedData, { vatRegistered, reverseCharge }).invoiceRows?.length ?? null : null),
    [extractedData, vatRegistered, reverseCharge],
  )
  const readingRowsChoice =
    put && lineCount != null && standAsPut(items, put, accounts, vatRegistered) ? { split: put.split, lineCount } : null

  // The reading's rows in their other form: the invoice's own lines, or back
  // to the rows it opens with, on the accounts already chosen.
  const toggleReadingRows = () => {
    if (!extractedData || !put) return
    const treatment = { vatRegistered, reverseCharge }
    const onScreen = getValues('items') ?? []
    putRows(
      readingFormRows(extractedData, treatment, !put.split, {
        thresholdFor: accrualThresholdRef.current,
        accountFor: accountCarriedFrom(onScreen, prefillAccount),
        reverseChargeRateFor: reverseChargeRateCarriedFrom(onScreen),
        chart: accounts,
      }),
      treatment,
    )
  }

  // The treatment changed after the reading: the rows are proposed again
  // for it unless the person has changed them (readingRowsForNewTreatment).
  useEffect(() => {
    const was = putTreatmentRef.current
    if (!was || !extractedData || !put) return
    if (was.reverseCharge === reverseCharge && was.vatRegistered === vatRegistered) return
    const treatment = { vatRegistered, reverseCharge }
    putTreatmentRef.current = treatment
    const next = readingRowsForNewTreatment(extractedData, treatment, put, getValues('items') ?? [], {
      thresholdFor: accrualThresholdRef.current,
      chart: accounts,
      prefillAccount,
    })
    if (next) putRows(next, treatment)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reverseCharge, vatRegistered])

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
            description: getErrorMessage(json, { fallback: t('inbox_load_failed_description') }),
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
    /**
     * Set while the invoice's own lines are a choice beside the rows the
     * reading opens with: which of the two is on screen, and how many lines
     * the invoice has.
     */
    readingRowsChoice,
    toggleReadingRows,
  }
}
