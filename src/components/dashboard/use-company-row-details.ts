'use client'

import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import type { Company } from '@/types'
import { companyRoleLabelKey, formatCreatedMoment, sameNameCreatedLabels } from '@/lib/company/company-copies'

/**
 * What a company row in a switcher list shows beside the name: the user's
 * role there by its label (none for the owner, the common case), and, when
 * another listed company carries the same name, a "Skapad ..." line that
 * tells the two apart (sameNameCreatedLabels).
 */
export function useCompanyRowDetails(companies: readonly { company: Pick<Company, 'id' | 'name' | 'created_at'> }[]) {
  const locale = useLocale()
  const t = useTranslations('company_switcher')
  const tRoles = useTranslations('settings_company')

  const created = useMemo(
    () =>
      sameNameCreatedLabels(
        companies.map(({ company: c }) => ({ id: c.id, name: c.name, createdAt: c.created_at ?? null })),
        (iso, precision) => formatCreatedMoment(iso, precision, locale),
      ),
    [companies, locale],
  )

  return {
    roleLabel(role: string): string | null {
      if (role === 'owner') return null
      const key = companyRoleLabelKey(role)
      return key ? tRoles(key) : null
    },
    createdLine(companyId: string): string | null {
      const date = created.get(companyId)
      return date ? t('created_on', { date }) : null
    },
  }
}
