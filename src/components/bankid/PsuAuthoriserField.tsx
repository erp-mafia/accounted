'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'

interface PsuAuthoriserFieldProps {
  value: string
  onChange: (value: string) => void
  /** The typed value is not a logon id the bank can take (lib/bank-feed/psu-authoriser.ts): the hint turns into the reason. */
  invalid?: boolean
  disabled?: boolean
}

/**
 * The optional Nordea Corporate Netbank logon id, under the personnummer of a
 * Nordea BankID signing (Koppla banken and the signatory link, Betalningar and
 * the payment signing link). Nordea Business users leave it empty. Typed each
 * time, sent to the bank with the signing, never stored.
 */
export function PsuAuthoriserField({ value, onChange, invalid = false, disabled = false }: PsuAuthoriserFieldProps) {
  const t = useTranslations('psu_authoriser')
  const hintId = useId()
  return (
    <label className="block space-y-2 text-[13px]">
      <span className="text-muted-foreground">{t('label')}</span>
      <Input
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        maxLength={64}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        className="w-[240px]"
      />
      <span id={hintId} className={invalid ? 'block text-xs text-destructive' : 'block text-xs text-muted-foreground'}>
        {invalid ? t('invalid') : t('hint')}
      </span>
    </label>
  )
}
