'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import {
  isBelowStatutorySemestertillagg,
  semestertillaggRateFromPercentInput,
} from '@/lib/salary/vacation-pay-rate'

/**
 * The "Semestertillägg" input under Semester in the new-employee and the
 * edit-employee form, shown for sammalöneregeln. The value is the percentage
 * as typed ("0,8"); the form posts it as `semestertillagg_rate` and the host
 * converts it with semestertillaggRateFromPercentInput. Below the statutory
 * 0,43 % (Semesterlagen 16 a §) it warns without refusing. crm#1529
 */
export default function SemestertillaggRateInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}) {
  const t = useTranslations('salary_employee')
  return (
    <>
      <Input
        id="semestertillagg_rate"
        name="semestertillagg_rate"
        type="number"
        step="0.001"
        min="0"
        max="5"
        placeholder="0.43"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
      <p className="text-xs text-muted-foreground">{t('form_semestertillagg_rate_hint')}</p>
      {isBelowStatutorySemestertillagg(semestertillaggRateFromPercentInput(value)) && (
        <p className="text-xs text-attn">{t('form_semestertillagg_rate_below_statutory')}</p>
      )}
    </>
  )
}
