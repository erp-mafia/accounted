'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Paperclip } from 'lucide-react'
import VatTreatmentSelect from './VatTreatmentSelect'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from './transaction-types'
import type { TransactionCategory, VatTreatment } from '@/types'

const expenseCategories = EXPENSE_CATEGORIES
const incomeCategories = INCOME_CATEGORIES

interface BatchCategorySelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedCount: number
  onSelectCategory: (category: TransactionCategory, vatTreatment?: VatTreatment) => void
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
  const [vatTreatment, setVatTreatment] = useState<VatTreatment | 'none'>('standard_25')
  const isProcessing = progress !== null

  const handleSelectCategory = (category: TransactionCategory) => {
    const resolvedVat = vatTreatment === 'none' ? undefined : vatTreatment
    onSelectCategory(category, resolvedVat)
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
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 p-3">
              <Paperclip className="h-4 w-4 text-warning-foreground mt-0.5 shrink-0" />
              <p className="text-xs text-warning-foreground">
                {t('underlag_reminder')}
              </p>
            </div>

            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">{t('vat_label')}</h4>
              <VatTreatmentSelect
                value={vatTreatment}
                onValueChange={setVatTreatment}
              />
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
                    onClick={() => handleSelectCategory(cat.value)}
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
                    onClick={() => handleSelectCategory(cat.value)}
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
