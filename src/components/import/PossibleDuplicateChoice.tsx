'use client'

import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface PossibleDuplicateChoiceProps {
  party: 'customer' | 'supplier'
  existingName: string
  /** True when the user said the row is the existing record. */
  confirmed: boolean
  onChange: (confirmed: boolean) => void
}

/**
 * The review-step choice for a row whose name matches an existing customer
 * or supplier while nothing else does (NAME_MATCH_POLICY 'ask' in
 * lib/import/shared/register-match.ts). It starts on "Ny": a name alone is
 * never merged unless the user picks the existing record.
 */
export function PossibleDuplicateChoice({
  party,
  existingName,
  confirmed,
  onChange,
}: PossibleDuplicateChoiceProps) {
  const t = useTranslations('import.register_match')
  const title = t(`${party}_possible_title`, { name: existingName })

  return (
    <Select value={confirmed ? 'same' : 'new'} onValueChange={(v) => onChange(v === 'same')}>
      <SelectTrigger className="h-8 w-40 px-3" title={title} aria-label={title}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="new">{t('choice_new')}</SelectItem>
        <SelectItem value="same">{t(`${party}_choice_same`)}</SelectItem>
      </SelectContent>
    </Select>
  )
}
