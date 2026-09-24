'use client'

import { useMemo, useState, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { useToast } from '@/components/ui/use-toast'
import { formatCurrency } from '@/lib/utils'
import type { InvoiceExtractionResult, VatTreatment } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { summarizeUnderlagTotals } from './bulk-book-inbox-totals'

// Minimal shape the dialog needs from the workspace's inbox items.
interface BulkBookInboxItem {
  id: string
  matched_transaction_id: string | null
  created_journal_entry_id: string | null
  created_supplier_invoice_id: string | null
  // Server-derived: the verifikat anchoring an already-booked matched
  // transaction (see InvoiceInboxWorkspace's InboxItem).
  matched_transaction_journal_entry_id?: string | null
  extracted_data: InvoiceExtractionResult | null
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  // The user's full checkbox selection. Non-bookable items are filtered out
  // and surfaced as a "skipped" count so the user understands the outcome.
  items: BulkBookInboxItem[]
  onSuccess: () => void | Promise<void>
}

// Swedish category labels: mirrors lib/bookkeeping/category-mapping.ts
// (categoryLabels), ordered expenses-first since underlag are overwhelmingly
// costs. Values match TransactionCategorySchema in lib/api/schemas.ts.
// Labels are built inside the component (they need the translator).

// VAT treatment options. `value` is typed as `VatTreatment` (types/index.ts)
// so this list can never drift from what the backend accepts: the bulk-book
// route feeds the value straight into buildMappingResultFromCategory, which
// only recognises these six. The 12% and 6% reduced rates are ALREADY covered
// here by `reduced_12` / `reduced_6`: there is deliberately no `standard_12` /
// `standard_6` (no such treatment exists; the backend would reject it). Keep
// this list in sync with the union, not with rate labels.
// Labels are built inside the component (they need the translator).

function isBookable(it: BulkBookInboxItem): boolean {
  return (
    Boolean(it.matched_transaction_id) &&
    !it.created_journal_entry_id &&
    !it.created_supplier_invoice_id &&
    // A matched transaction that is already booked has nothing left to book:
    // the server would only skip it as already_booked_or_duplicate.
    !it.matched_transaction_journal_entry_id
  )
}

export default function BulkBookInboxDialog({ open, onOpenChange, items, onSuccess }: Props) {
  const { toast } = useToast()
  const t = useTranslations('inbox_bulk_book')
  const [category, setCategory] = useState<string>('')
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'auto'>('auto')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const CATEGORY_OPTIONS: { value: string; label: string }[] = [
    { value: 'expense_software', label: t('category_expense_software') },
    { value: 'expense_office', label: t('category_expense_office') },
    { value: 'expense_consumables', label: t('category_expense_consumables') },
    { value: 'expense_equipment', label: t('category_expense_equipment') },
    { value: 'expense_telecom', label: t('category_expense_telecom') },
    { value: 'expense_travel', label: t('category_expense_travel') },
    { value: 'expense_marketing', label: t('category_expense_marketing') },
    { value: 'expense_professional_services', label: t('category_expense_professional_services') },
    { value: 'expense_education', label: t('category_expense_education') },
    { value: 'expense_representation', label: t('category_expense_representation') },
    { value: 'expense_vehicle', label: t('category_expense_vehicle') },
    { value: 'expense_bank_fees', label: t('category_expense_bank_fees') },
    { value: 'expense_card_fees', label: t('category_expense_card_fees') },
    { value: 'expense_currency_exchange', label: t('category_expense_currency_exchange') },
    { value: 'expense_other', label: t('category_expense_other') },
    { value: 'income_services', label: t('category_income_services') },
    { value: 'income_products', label: t('category_income_products') },
    { value: 'income_other', label: t('category_income_other') },
    { value: 'private', label: t('category_private') },
  ]
  const VAT_OPTIONS: { value: VatTreatment | 'auto'; label: string }[] = [
    // 'auto' sends no explicit treatment: the bulk-book route derives the
    // default from the picked category (exempt for bank/card fees, 12%
    // representation, else 25%). Reverse charge is never derived; see below.
    { value: 'auto', label: t('vat_auto') },
    { value: 'standard_25', label: t('vat_standard_25') },
    { value: 'reduced_12', label: t('vat_reduced_12') },
    { value: 'reduced_6', label: t('vat_reduced_6') },
    { value: 'reverse_charge', label: t('vat_reverse_charge') },
    { value: 'export', label: t('vat_export') },
    { value: 'exempt', label: t('vat_exempt') },
  ]

  const bookable = useMemo(() => items.filter(isBookable), [items])
  const notMatched = useMemo(
    () => items.filter((it) => !it.matched_transaction_id && !it.created_journal_entry_id && !it.created_supplier_invoice_id).length,
    [items],
  )
  const alreadyBooked = useMemo(
    () =>
      items.filter(
        (it) =>
          it.created_journal_entry_id ||
          it.created_supplier_invoice_id ||
          it.matched_transaction_journal_entry_id,
      ).length,
    [items],
  )

  // Reset to the category-derived default each time the dialog opens.
  // Currency is deliberately NOT used to preselect omvänd skattskyldighet: a
  // foreign currency does not imply a foreign seller: a Swedish supplier can
  // invoice in EUR and still debit 25% moms. Reverse charge is a property of
  // the seller (utländsk, utan svenskt momsnr), never of the currency, and the
  // server-side derivation never produces it either, so it is only ever an
  // explicit user choice. The advisory rendered under the Moms picker spells
  // this out to the user.
  useEffect(() => {
    if (open) setVatTreatment('auto')
  }, [open])

  // Underlag subtotals, split per currency. This used to be a single scalar
  // named `totalSek` that summed `totals.total` across the selection and was
  // rendered with formatCurrency()'s SEK default, so a mixed batch added 100
  // EUR to 100 SEK and stamped "kr" on the result: a figure the user approved
  // against that matched no belopp at all (BFL 5 kap 7 §). The split is honest
  // in both directions: a homogeneous EUR batch now reads in EUR too.
  //
  // Deliberately NOT a submit gate, unlike the mixed-currency dead end in
  // components/transactions/BulkBookDialog.tsx. That dialog builds ONE
  // samlingsverifikation, which must sit in a single redovisningsvaluta (BFL 4
  // kap 6 §). This route books one verifikat PER underlag off its matched bank
  // transaction's own settled amount (see lib/transactions/categorize-core.ts),
  // so a EUR invoice paid by a SEK bank line is booked correctly and a mixed
  // selection yields a set of individually correct verifikat. Blocking it would
  // refuse a legal everyday batch. See bulk-book-inbox-totals.ts.
  const underlagTotals = useMemo(() => summarizeUnderlagTotals(bookable), [bookable])
  const isMixedCurrency = underlagTotals.length > 1

  const submit = async () => {
    if (!category || bookable.length === 0) return
    setIsSubmitting(true)
    try {
      const res = await fetch('/api/extensions/ext/invoice-inbox/items/bulk-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          item_ids: bookable.map((it) => it.id),
          category,
          ...(vatTreatment !== 'auto' ? { vat_treatment: vatTreatment } : {}),
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`)
      }
      const bookedCount: number = json.data?.booked_count ?? 0
      const skippedCount: number = json.data?.skipped_count ?? 0
      const parts: string[] = []
      if (bookedCount > 0) parts.push(t('booked_count', { count: bookedCount }))
      if (skippedCount > 0) parts.push(t('skipped_count', { count: skippedCount }))
      toast({
        title: t('done_title'),
        description: parts.join(' · ') || t('none_booked'),
        variant: bookedCount === 0 ? 'destructive' : 'default',
      })
      onOpenChange(false)
      await onSuccess()
    } catch (err) {
      toast({
        title: t('failed_title'),
        description: err instanceof Error ? getUserErrorMessage(err) : t('unknown_error'),
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const skippedNote: string | null = useMemo(() => {
    const bits: string[] = []
    if (notMatched > 0) bits.push(t('not_matched_count', { count: notMatched }))
    if (alreadyBooked > 0) bits.push(t('already_booked_count', { count: alreadyBooked }))
    return bits.length > 0 ? bits.join(' · ') : null
  }, [notMatched, alreadyBooked, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('book_n_documents', { count: bookable.length })}</DialogTitle>
          <DialogDescription>
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bulk-category">{t('category_label')}</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="bulk-category">
                <SelectValue placeholder={t('category_placeholder')} />
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Label htmlFor="bulk-vat">{t('vat_label')}</Label>
              <InfoTooltip
                content={t.rich('vat_tooltip', { b: (c) => <strong>{c}</strong> })}
              />
            </div>
            <Select value={vatTreatment} onValueChange={(v) => setVatTreatment(v as VatTreatment | 'auto')}>
              <SelectTrigger id="bulk-vat">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VAT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {vatTreatment === 'reverse_charge' && (
              <div className="rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                {t.rich('reverse_charge_warning', {
                  b: (c) => <strong className="font-medium text-foreground">{c}</strong>,
                })}
              </div>
            )}
          </div>

          {!isMixedCurrency && underlagTotals.length === 1 && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('total_label', {
                amount: formatCurrency(underlagTotals[0]!.total, underlagTotals[0]!.currency),
              })}
            </p>
          )}

          {isMixedCurrency && (
            <div className="rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('mixed_currency_totals_label')}</p>
              <ul className="mt-2 space-y-1">
                {underlagTotals.map(({ currency, total }) => (
                  <li key={currency} className="flex items-center justify-between tabular-nums">
                    <span className="font-mono">{currency}</span>
                    <span className="text-foreground">{formatCurrency(total, currency)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2">{t('mixed_currency_note')}</p>
            </div>
          )}

          {skippedNote && (
            <p className="text-xs text-muted-foreground">
              {t('skipped_note', { note: skippedNote })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!category || bookable.length === 0} loading={isSubmitting}>
            {t('book_n_documents', { count: bookable.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
