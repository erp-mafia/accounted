'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import VatTreatmentSelect from './VatTreatmentSelect'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './transaction-types'
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import type { TransactionCategory, VatTreatment } from '@/types'

const expenseCategories = EXPENSE_CATEGORIES
const incomeCategories = INCOME_CATEGORIES

/**
 * The boxes a batch reverse charge can name (the categorize route's
 * reverse_charge_kind): a bank row says nothing about its seller, so the
 * person states the box for the selection, as the single-row review lets
 * them pick it, instead of every row landing in ruta 21 (#58).
 */
const REVERSE_CHARGE_BOXES = ['eu_services', 'non_eu_services', 'eu_goods'] as const satisfies readonly ReverseChargeKind[]

/** A section label (Stil v3): 12px/500 in sentence case, the same look as a field label. */
const SECTION_LABEL_CLASS = 'text-[12px] font-medium leading-4 text-foreground/80'

/**
 * A choice chip (Stil v3 dialog anatomy): a 28px 6px rectangle on a hairline
 * at rest, on the wash while chosen. aria-pressed carries the state.
 */
const CHOICE_CHIP_CLASS =
  'inline-flex h-7 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-[background-color,box-shadow,color,transform] duration-150 active:scale-[0.97] active:duration-100 motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-40'
const CHOICE_CHIP_REST_CLASS =
  'text-muted-foreground shadow-[inset_0_0_0_0.5px_hsl(var(--line-strong))] hover:bg-secondary/60 hover:text-foreground'
const CHOICE_CHIP_PRESSED_CLASS = 'bg-secondary text-strong'

interface BatchCategorySelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedCount: number
  onSelectCategory: (category: TransactionCategory, vatTreatment?: VatTreatment, reverseChargeKind?: ReverseChargeKind) => void
  progress: { done: number; total: number } | null
}

export default function BatchCategorySelector({
  open,
  onOpenChange,
  selectedCount,
  onSelectCategory,
  progress,
}: BatchCategorySelectorProps) {
  const t = useTranslations('tx_batch_selector')
  const tCat = useTranslations('tx_categories')
  const tJournal = useTranslations('journal_form')
  const tCommon = useTranslations('common')
  // 'auto' sends no explicit treatment: the server derives the correct default
  // per category (exempt for bank/card fees, 12% representation, else 25%).
  // A hardcoded 'standard_25' initial value used to override that derivation
  // and claim 25% moms on VAT-exempt bank fees.
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none' | 'auto'>('auto')
  const [reverseChargeKind, setReverseChargeKind] = useState<ReverseChargeKind | ''>('')
  // The category chosen for the whole selection. Picking a chip only chooses
  // it; the footer's primary books the selection with it.
  const [chosen, setChosen] = useState<{ category: TransactionCategory; isExpense: boolean } | null>(null)
  const isProcessing = progress !== null
  // A reverse-charge purchase books no box until the person names one.
  const expenseNeedsBox = vatTreatment === 'reverse_charge' && !reverseChargeKind
  const blockedByBox = chosen?.isExpense === true && expenseNeedsBox
  const canConfirm = !isProcessing && chosen !== null && !blockedByBox

  const handleSelectCategory = (category: TransactionCategory, isExpense: boolean) => {
    // 'auto' omits the treatment so the server derives it per category. An
    // explicit 'Ingen moms' goes over the wire as 'exempt' (books no VAT
    // line): the old collapse to undefined made an explicit no-VAT choice
    // book the DERIVED default, i.e. 25% moms on most expense categories.
    const resolvedVat =
      vatTreatment === 'auto' ? undefined : vatTreatment === 'none' ? 'exempt' : vatTreatment
    // The box belongs to a purchase only: a sale under reverse charge has none.
    const kind = resolvedVat === 'reverse_charge' && isExpense && reverseChargeKind ? reverseChargeKind : undefined
    onSelectCategory(category, resolvedVat, kind)
  }

  const handleConfirm = () => {
    if (!canConfirm || !chosen) return
    handleSelectCategory(chosen.category, chosen.isExpense)
  }

  const chipGroup = (
    label: string,
    categories: typeof EXPENSE_CATEGORIES,
    isExpense: boolean,
  ) => (
    <section className="space-y-2">
      <h3 className={SECTION_LABEL_CLASS}>{label}</h3>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
        {categories.map((cat) => {
          const pressed = chosen?.category === cat.value && chosen.isExpense === isExpense
          return (
            <button
              key={cat.value}
              type="button"
              aria-pressed={pressed}
              onClick={() => setChosen({ category: cat.value, isExpense })}
              className={cn(CHOICE_CHIP_CLASS, pressed ? CHOICE_CHIP_PRESSED_CLASS : CHOICE_CHIP_REST_CLASS)}
            >
              {tCat(cat.labelKey)}
            </button>
          )
        })}
      </div>
    </section>
  )

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : onOpenChange}>
      <DialogContent size="form">
        <DialogHeader>
          <DialogTitle>
            {isProcessing
              ? t('title_processing', { done: progress.done, total: progress.total })
              : t('title_default', { count: selectedCount })}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? t('description_processing')
              : t('description_default')}
          </DialogDescription>
        </DialogHeader>

        {isProcessing ? (
          <Progress
            value={(progress.done / progress.total) * 100}
            aria-label={t('progress_label', { done: progress.done, total: progress.total })}
          />
        ) : (
          <div className="space-y-5">
            {chipGroup(t('expenses_label'), expenseCategories, true)}
            {chipGroup(t('income_label'), incomeCategories, false)}

            <section className="space-y-1.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1">
                  <Label>{t('vat_label')}</Label>
                  <VatTreatmentSelect
                    value={vatTreatment}
                    onValueChange={setVatTreatment}
                    allowAuto
                  />
                </div>
                {vatTreatment === 'reverse_charge' && (
                  <div className="min-w-0 space-y-1">
                    <Label htmlFor="batch-reverse-charge-box">{t('reverse_charge_box_label')}</Label>
                    <Select value={reverseChargeKind} onValueChange={(v) => setReverseChargeKind(v as ReverseChargeKind)}>
                      <SelectTrigger id="batch-reverse-charge-box" aria-invalid={blockedByBox || undefined}>
                        <SelectValue placeholder={t('reverse_charge_box_placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {REVERSE_CHARGE_BOXES.map((kind) => (
                          <SelectItem key={kind} value={kind}>
                            {tJournal(`vat_code_kind_${kind}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {vatTreatment === 'reverse_charge' && (
                <p className="text-[12px] leading-4 text-muted-foreground">{t('reverse_charge_box_hint')}</p>
              )}
            </section>
          </div>
        )}

        <DialogFooter>
          <DialogConsequence aria-live="polite">
            {isProcessing
              ? t('progress_label', { done: progress.done, total: progress.total })
              : t('consequence')}
          </DialogConsequence>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isProcessing}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm} loading={isProcessing}>
            {t('title_default', { count: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
