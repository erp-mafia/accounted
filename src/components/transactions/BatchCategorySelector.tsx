'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PaperClipIcon } from '@/components/icons'
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
  // 'auto' sends no explicit treatment: the server derives the correct default
  // per category (exempt for bank/card fees, 12% representation, else 25%).
  // A hardcoded 'standard_25' initial value used to override that derivation
  // and claim 25% moms on VAT-exempt bank fees.
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none' | 'auto'>('auto')
  const [reverseChargeKind, setReverseChargeKind] = useState<ReverseChargeKind | ''>('')
  const isProcessing = progress !== null
  // A reverse-charge purchase books no box until the person names one.
  const expenseNeedsBox = vatTreatment === 'reverse_charge' && !reverseChargeKind

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

  return (
    <Dialog open={open} onOpenChange={isProcessing ? undefined : onOpenChange}>
      <DialogContent className="max-w-md">
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
          <div className="py-4">
            <Progress value={(progress.done / progress.total) * 100} />
            <p className="text-sm text-muted-foreground mt-2 text-center">
              {t('progress_label', { done: progress.done, total: progress.total })}
            </p>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Underlag reminder */}
            <div className="flex items-start gap-2 rounded-lg bg-muted/30 border border-border p-3">
              <PaperClipIcon className="h-4 w-4 text-attn mt-0.5 shrink-0" />
              <p className="text-xs text-attn">
                {t('underlag_reminder')}
              </p>
            </div>

            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">{t('vat_label')}</h4>
              <VatTreatmentSelect
                value={vatTreatment}
                onValueChange={setVatTreatment}
                allowAuto
              />
              {vatTreatment === 'reverse_charge' && (
                <div className="mt-3 space-y-1.5">
                  <h4 className="text-sm font-medium text-muted-foreground">{t('reverse_charge_box_label')}</h4>
                  <Select value={reverseChargeKind} onValueChange={(v) => setReverseChargeKind(v as ReverseChargeKind)}>
                    <SelectTrigger className="h-9">
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
                  <p className="text-xs text-muted-foreground">{t('reverse_charge_box_hint')}</p>
                </div>
              )}
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">{t('expenses_label')}</h4>
              <div className="grid grid-cols-2 gap-1.5">
                {expenseCategories.map((cat) => (
                  <Button
                    key={cat.value}
                    variant="outline"
                    size="sm"
                    className="justify-start text-xs"
                    disabled={expenseNeedsBox}
                    onClick={() => handleSelectCategory(cat.value, true)}
                  >
                    {tCat(cat.labelKey)}
                  </Button>
                ))}
              </div>
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">{t('income_label')}</h4>
              <div className="grid grid-cols-2 gap-1.5">
                {incomeCategories.map((cat) => (
                  <Button
                    key={cat.value}
                    variant="outline"
                    size="sm"
                    className="justify-start text-xs"
                    onClick={() => handleSelectCategory(cat.value, false)}
                  >
                    {tCat(cat.labelKey)}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
