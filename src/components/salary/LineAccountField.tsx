'use client'

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { Label } from '@/components/ui/label'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { useAccounts } from '@/lib/reference-data/hooks'
import { useBasCatalog } from '@/lib/hooks/use-bas-catalog'
import { lineItemAccount, type MoneyLineItemType } from '@/lib/salary/account-mapping'
import { isRunComputedTaxAccount, lineAccountOverride } from '@/lib/salary/line-account-override'

/**
 * The account override on a payslip or recurring row. Empty means the
 * default, which the booking resolves from the item type and the employee
 * (lineItemAccount) and which shows as the placeholder. Rendered only for row
 * types that post on their own account (lineAccountOverride); pay rows list
 * class 7 only. The salary booking activates a standard BAS account the
 * chart lacks, so the full catalogue is offered.
 */
export function LineAccountField({
  id,
  itemType,
  defaultAccount: rowDefaultAccount,
  employmentType,
  personnelCategory,
  value,
  onChange,
  invalid,
}: {
  id: string
  itemType: string
  /** The account the row is written with when nothing is picked (an utlandstraktamente: 7323 / 7324). */
  defaultAccount?: string
  employmentType: string
  personnelCategory: string | null | undefined
  value: string
  onChange: (account: string) => void
  invalid?: boolean
}) {
  const t = useTranslations('salary_employee')
  const rule = lineAccountOverride(itemType)
  const { accounts } = useAccounts()
  const { catalog } = useBasCatalog({ includeDeactivated: true })
  const classSeven = rule === 'class_7'
  const offered = useMemo(
    () => (classSeven ? accounts.filter((a) => a.account_class === 7) : accounts),
    [accounts, classSeven],
  )
  const offeredCatalog = useMemo(
    () => (classSeven ? catalog.filter((a) => a.account_class === 7) : catalog),
    [catalog, classSeven],
  )

  if (rule === 'none') return null
  const defaultAccount =
    rowDefaultAccount ?? lineItemAccount(itemType as MoneyLineItemType, { employmentType, personnelCategory })
  // The run books its own tax and avgifter there: say where extra tax goes.
  const invalidKey = isRunComputedTaxAccount(value.trim())
    ? 'line_account_invalid_tax_account'
    : classSeven
      ? 'line_account_invalid_class_7'
      : 'line_account_invalid'

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('line_account_label')}</Label>
      <div className="max-w-xs">
        <AccountCombobox
          id={id}
          value={value}
          accounts={offered}
          catalog={offeredCatalog}
          onChange={onChange}
          placeholder={t('line_account_default', { account: defaultAccount })}
          notActivatedLabel={t('line_account_not_activated')}
        />
      </div>
      <p className={invalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} aria-live="polite">
        {invalid ? t(invalidKey) : t(classSeven ? 'line_account_hint_class_7' : 'line_account_hint_any')}
      </p>
    </div>
  )
}
