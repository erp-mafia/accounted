'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SettingsGroup, SettingsRow, SettingsSelect } from '@/components/settings/SettingsRows'
import { VacationLiabilityMethodDialog } from '@/components/salary/VacationLiabilityConfirmDialog'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import {
  VACATION_LIABILITY_METHODS,
  vacationLiabilityMethodFrom,
  type VacationLiabilityMethod,
} from '@/lib/salary/vacation-liability-method'
import type { CompanySettings } from '@/types'

/**
 * Semesterlöneskuld on the salary settings page: how the liability is
 * booked. Choosing an option opens the confirm dialog (convention 10) that
 * states what the change does; switching to booking the liability at every
 * run shows the first catch-up verifikat (amount, date, lines) before
 * anything changes. The dialog's confirm is the save: the row never goes
 * through the page's sticky save bar, because the change can post.
 */
export function VacationLiabilitySettings({
  settings,
  onSaved,
}: {
  settings: CompanySettings
  onSaved: (updates: Partial<CompanySettings>) => void
}) {
  const t = useTranslations('settings_salary')
  const { canWrite } = useCanWrite()
  const saved = vacationLiabilityMethodFrom(settings.salary_vacation_liability_method)
  const [pending, setPending] = useState<VacationLiabilityMethod | null>(null)

  return (
    <SettingsGroup className="pt-0 first:pt-0">
      <VacationLiabilityMethodRow
        value={pending ?? saved}
        disabled={!canWrite}
        onChoose={(method) => {
          if (method !== saved) setPending(method)
        }}
        labels={{
          label: t('vacation_liability_label'),
          help: t('vacation_liability_help'),
          accrual: t('vacation_liability_accrual'),
          remeasure: t('vacation_liability_remeasure'),
        }}
      />
      {pending && (
        <VacationLiabilityMethodDialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null)
          }}
          method={pending}
          onDone={(method) => {
            onSaved({ salary_vacation_liability_method: method })
            setPending(null)
          }}
        />
      )}
    </SettingsGroup>
  )
}

/** The row itself, from plain props: the sandbox preview renders it alone. */
export function VacationLiabilityMethodRow({
  value,
  disabled,
  onChoose,
  labels,
}: {
  value: VacationLiabilityMethod
  disabled?: boolean
  onChoose: (method: VacationLiabilityMethod) => void
  labels: { label: string; help: string; accrual: string; remeasure: string }
}) {
  return (
    <SettingsRow label={labels.label} htmlFor="salary_vacation_liability_method" help={labels.help}>
      <SettingsSelect
        id="salary_vacation_liability_method"
        value={value}
        disabled={disabled}
        onChange={(e) => onChoose(vacationLiabilityMethodFrom(e.target.value))}
      >
        {VACATION_LIABILITY_METHODS.map((method) => (
          <option key={method} value={method}>
            {method === 'remeasure' ? labels.remeasure : labels.accrual}
          </option>
        ))}
      </SettingsSelect>
    </SettingsRow>
  )
}
