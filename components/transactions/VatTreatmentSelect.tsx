'use client'

import * as SelectPrimitive from '@radix-ui/react-select'
import { Check } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { VAT_TREATMENT_OPTIONS } from './transaction-types'
import type { VatTreatment } from '@/types'

type VatSelectValue = VatTreatment | 'none' | 'auto'

// The "auto" option is opt-in (allowAuto): it means "no explicit treatment,
// the server derives it from the picked category" and is only meaningful in
// flows that submit category + treatment together (batch booking).
const AUTO_OPTION = { value: 'auto', labelKey: 'vat_auto', descriptionKey: 'vat_auto_desc' } as const

interface VatTreatmentSelectProps<T extends VatSelectValue> {
  value: T
  onValueChange: (value: T) => void
  disabled?: boolean
  allowAuto?: boolean
}

export default function VatTreatmentSelect<T extends VatSelectValue>({
  value,
  onValueChange,
  disabled,
  allowAuto,
}: VatTreatmentSelectProps<T>) {
  const t = useTranslations('tx_categories')
  const options: ReadonlyArray<{ value: VatSelectValue; labelKey: string; descriptionKey?: string }> =
    allowAuto ? [AUTO_OPTION, ...VAT_TREATMENT_OPTIONS] : VAT_TREATMENT_OPTIONS
  return (
    <Select
      value={value}
      onValueChange={(v) => { if (v) onValueChange(v as T) }}
      disabled={disabled}
    >
      <SelectTrigger className="h-9">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectPrimitive.Item
            key={opt.value}
            value={opt.value}
            className={cn(
              'relative flex w-full cursor-default select-none items-start rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors focus:bg-secondary focus:text-secondary-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50'
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
