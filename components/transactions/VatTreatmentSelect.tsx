'use client'

import * as SelectPrimitive from '@radix-ui/react-select'
import { Check } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { VAT_TREATMENT_OPTIONS } from './transaction-types'
import type { VatTreatment } from '@/types'

interface VatTreatmentSelectProps {
  value: VatTreatment | 'none'
  onValueChange: (value: VatTreatment | 'none') => void
  disabled?: boolean
}

export default function VatTreatmentSelect({
  value,
  onValueChange,
  disabled,
}: VatTreatmentSelectProps) {
  const t = useTranslations('tx_categories')
  return (
    <Select
      value={value}
      onValueChange={(v) => { if (v) onValueChange(v as VatTreatment | 'none') }}
      disabled={disabled}
    >
      <SelectTrigger className="h-9">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {VAT_TREATMENT_OPTIONS.map((opt) => (
          <SelectPrimitive.Item
            key={opt.value}
            value={opt.value}
            className={cn(
              'relative flex w-full cursor-default select-none items-start rounded-md py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-secondary focus:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
            )}
          >
            <span className="absolute left-2 top-2 flex h-3.5 w-3.5 items-center justify-center">
              <SelectPrimitive.ItemIndicator>
                <Check className="h-4 w-4 text-primary" />
              </SelectPrimitive.ItemIndicator>
            </span>
            <div>
              <SelectPrimitive.ItemText>{t(opt.labelKey)}</SelectPrimitive.ItemText>
              {opt.descriptionKey && (
                <p className="text-xs text-muted-foreground mt-0.5 font-normal">
                  {t(opt.descriptionKey)}
                </p>
              )}
            </div>
          </SelectPrimitive.Item>
        ))}
      </SelectContent>
    </Select>
  )
}
