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
import { Loader2 } from 'lucide-react'
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
const CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: 'expense_software', label: 'Programvara/IT-tjänster' },
  { value: 'expense_office', label: 'Kontorskostnad' },
  { value: 'expense_consumables', label: 'Förbrukningsvaror' },
  { value: 'expense_equipment', label: 'Förbrukningsinventarier' },
  { value: 'expense_telecom', label: 'Telefon & internet' },
  { value: 'expense_travel', label: 'Resekostnad' },
  { value: 'expense_marketing', label: 'Marknadsföring' },
  { value: 'expense_professional_services', label: 'Konsulttjänst' },
  { value: 'expense_education', label: 'Utbildning' },
  { value: 'expense_representation', label: 'Representation' },
  { value: 'expense_vehicle', label: 'Bil & drivmedel' },
  { value: 'expense_bank_fees', label: 'Bankavgift' },
  { value: 'expense_card_fees', label: 'Kortavgift' },
  { value: 'expense_currency_exchange', label: 'Valutaväxling' },
  { value: 'expense_other', label: 'Övrig kostnad' },
  { value: 'income_services', label: 'Tjänsteförsäljning' },
  { value: 'income_products', label: 'Varuförsäljning' },
  { value: 'income_other', label: 'Övrig intäkt' },
  { value: 'private', label: 'Privat' },
]

// VAT treatment options. `value` is typed as `VatTreatment` (types/index.ts)
// so this list can never drift from what the backend accepts: the bulk-book
// route feeds the value straight into buildMappingResultFromCategory, which
// only recognises these six. The 12% and 6% reduced rates are ALREADY covered
// here by `reduced_12` / `reduced_6`: there is deliberately no `standard_12` /
// `standard_6` (no such treatment exists; the backend would reject it). Keep
// this list in sync with the union, not with rate labels.
const VAT_OPTIONS: { value: VatTreatment | 'auto'; label: string }[] = [
  // 'auto' sends no explicit treatment: the bulk-book route derives the
  // default from the picked category (exempt for bank/card fees, 12%
  // representation, else 25%). Reverse charge is never derived; see below.
  { value: 'auto', label: 'Enligt kategori' },
  { value: 'standard_25', label: 'Moms 25%' },
  { value: 'reduced_12', label: 'Moms 12%' },
  { value: 'reduced_6', label: 'Moms 6%' },
  { value: 'reverse_charge', label: 'Omvänd skattskyldighet (EU/utland)' },
  { value: 'export', label: 'Export (0%)' },
  { value: 'exempt', label: 'Momsfri' },
]

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
      if (bookedCount > 0) parts.push(`${bookedCount} bokförda`)
      if (skippedCount > 0) parts.push(`${skippedCount} överhoppade`)
      toast({
        title: 'Bulkbokföring klar',
        description: parts.join(' · ') || 'Inga underlag bokfördes',
        variant: bookedCount === 0 ? 'destructive' : 'default',
      })
      onOpenChange(false)
      await onSuccess()
    } catch (err) {
      toast({
        title: 'Bokföringen misslyckades',
        description: err instanceof Error ? getUserErrorMessage(err) : 'Okänt fel',
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const skippedNote: string | null = useMemo(() => {
    const bits: string[] = []
    if (notMatched > 0) bits.push(`${notMatched} saknar matchad transaktion`)
    if (alreadyBooked > 0) bits.push(`${alreadyBooked} redan bokförda`)
    return bits.length > 0 ? bits.join(' · ') : null
  }, [notMatched, alreadyBooked])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bokför {bookable.length} underlag</DialogTitle>
          <DialogDescription>
            Varje underlag bokförs mot sin matchade banktransaktion med samma kategori och momsbehandling.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="bulk-category">Kategori</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="bulk-category">
                <SelectValue placeholder="Välj kategori" />
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
              <Label htmlFor="bulk-vat">Moms</Label>
              <InfoTooltip
                content={
                  <>
                    Välj <strong>Omvänd skattskyldighet</strong> för köp från en utländsk säljare utan
                    svenskt momsnummer (t.ex. EU-tjänster som moln/mjukvara). Svenska fakturor med moms:
                    välj den sats kvittot visar: valutan avgör inte.
                  </>
                }
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
                <strong className="font-medium text-foreground">Kontrollera säljaren.</strong>{' '}
                Omvänd skattskyldighet gäller bara köp från en <strong className="font-medium text-foreground">utländsk
                säljare utan svenskt momsregistreringsnummer</strong>: t.ex. EU-tjänster, EU-varor,
                byggtjänster eller viss elektronik. Valutan avgör inte: en svensk säljare kan fakturera i
                EUR och ändå debitera 25% moms. Är säljaren svensk och momsen står på kvittot, välj i
                stället rätt momssats ovan.
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
              Hoppas över: {skippedNote}.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Avbryt
          </Button>
          <Button onClick={submit} disabled={isSubmitting || !category || bookable.length === 0}>
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Bokför {bookable.length} underlag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
