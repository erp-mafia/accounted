'use client'

import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PROPOSAL_REVERSE_CHARGE_KINDS } from '@/lib/bookkeeping/proposal'
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'

interface ReverseChargeBoxSelectProps {
  value: ReverseChargeKind
  onValueChange: (kind: ReverseChargeKind) => void
  /** Names the field for a screen reader: the visible label is not tied to it. */
  ariaLabel: string
  disabled?: boolean
}

/**
 * The box a reverse-charge purchase reports its basis in: ruta 20 (goods from
 * another EU country), 21 (services from another EU country) or 22 (services
 * from outside the EU), named as the manual verifikat's momskod names them.
 */
export default function ReverseChargeBoxSelect({ value, onValueChange, ariaLabel, disabled }: ReverseChargeBoxSelectProps) {
  const t = useTranslations('journal_form')
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        const kind = PROPOSAL_REVERSE_CHARGE_KINDS.find((k) => k === v)
        if (kind) onValueChange(kind)
      }}
      disabled={disabled}
    >
      <SelectTrigger className="h-9" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PROPOSAL_REVERSE_CHARGE_KINDS.map((kind) => (
          <SelectItem key={kind} value={kind}>
            {t(`vat_code_kind_${kind}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
