'use client'

import { useTranslations } from 'next-intl'
import { describeFilledFields } from '@/lib/parties/registry-form-fill'
import { listSv } from '@/lib/parties/registry-summary'
import { formatOrgNumber } from '@/lib/utils'
import type { RegistryAutofillState } from './use-registry-autofill'

/**
 * The one line under the org number field that says what the register
 * did: looking, "Webhallen Sverige AB · namn och adress från SCB", found
 * but nothing to fill, or no such company. Nothing while idle, which is
 * also what an environment without SCB shows.
 */
export function RegistryAutofillNote({ state }: { state: RegistryAutofillState }) {
  const t = useTranslations('parties')
  if (state.status === 'idle') return null
  let text: string
  switch (state.status) {
    case 'looking':
      text = t('autofill_looking')
      break
    case 'not_found':
      text = t('autofill_not_found', { org: formatOrgNumber(state.orgNumber) })
      break
    case 'found':
      text = t('autofill_found', { name: state.name })
      break
    case 'filled': {
      const labels = describeFilledFields(state.fields).map((f) => {
        switch (f) {
          case 'name':
            return t('autofill_field_name')
          case 'address':
            return t('facts_address_short')
          case 'email':
            return t('autofill_field_email')
          case 'phone':
            return t('autofill_field_phone')
          case 'vat_number':
            return t('autofill_field_vat')
        }
      })
      text = t('autofill_filled', { name: state.name, fields: listSv(labels, t('facts_list_and')) })
      break
    }
  }
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite">
      {text}
    </p>
  )
}
