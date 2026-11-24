'use client'

import Link from 'next/link'
import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsGroup, SettingsRow, SettingsRowNote, SettingsSelect } from '@/components/settings/SettingsRows'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  getCurrentVacationYear,
  vacationBasisAgreementPrompt,
  vacationBasisControl,
  type VacationBasisChangeAnswer,
  type VacationBasisControl,
  type VacationYearBasis,
} from '@/lib/salary/vacation-year'
import { formatDate } from '@/lib/utils'
import type { CompanySettings } from '@/types'

const BASES: VacationYearBasis[] = ['calendar', 'statutory_apr_mar']

function asBasis(value: unknown): VacationYearBasis {
  return value === 'statutory_apr_mar' ? 'statutory_apr_mar' : 'calendar'
}

/**
 * Semesterår on the salary settings page: a choice between calendar year and
 * the statutory 1 April to 31 March while the settings service accepts a
 * change, otherwise the saved basis locked with the service's reason (open
 * vacation-ledger rows, which the first booked run creates). The lock state
 * comes from GET /api/settings/vacation-year-basis, which asks the same
 * function the save does. Its own small form so the choice saves alone.
 * A year other than 1 April to 31 March needs a kollektivavtal
 * (vacationBasisAgreementPrompt): saved, a quiet note says so; being chosen,
 * the save waits for the person to confirm one allows it.
 */
export function VacationYearSettings({
  settings,
  onSaved,
}: {
  settings: CompanySettings
  onSaved: (updates: Partial<CompanySettings>) => void
}) {
  const t = useTranslations('settings_salary')
  const savedBasis = asBasis(settings.salary_vacation_year_basis)
  const [basis, setBasis] = useState<VacationYearBasis | null>(null)
  const [agreementConfirmed, setAgreementConfirmed] = useState(false)
  const effectiveBasis = basis ?? savedBasis

  const { data, error, mutate } = useSWR<VacationBasisChangeAnswer>(
    ['/api/settings/vacation-year-basis', settings.company_id],
    async ([url]: [string, string]) => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(String(res.status))
      return ((await res.json()) as { data: VacationBasisChangeAnswer }).data
    },
  )
  const control: VacationBasisControl = vacationBasisControl(data, Boolean(error))
  const shownBasis = control.state === 'choice' ? effectiveBasis : savedBasis
  const currentVacationYear = getCurrentVacationYear(formatDate(new Date()), effectiveBasis)
  const agreementPrompt = vacationBasisAgreementPrompt(savedBasis, shownBasis)
  const awaitingAgreement = agreementPrompt === 'confirm' && !agreementConfirmed

  function handleSave(formData: FormData) {
    const next = asBasis(formData.get('salary_vacation_year_basis'))
    if (next === savedBasis || awaitingAgreement) return {}
    return {
      updates: { salary_vacation_year_basis: next },
      onSuccess: (saved: Record<string, unknown>) => {
        onSaved(saved as Partial<CompanySettings>)
        setBasis(null)
        setAgreementConfirmed(false)
        void mutate()
      },
    }
  }

  return (
    <SettingsFormWrapper onSave={handleSave} saveDisabled={awaitingAgreement}>
      <SettingsGroup label={t('vacation_heading')}>
        <SettingsRow label={t('vacation_year_label')} htmlFor="salary_vacation_year_basis" help={t('vacation_year_help')}>
          <div className="flex flex-col gap-1">
            <SettingsSelect
              id="salary_vacation_year_basis"
              name="salary_vacation_year_basis"
              value={shownBasis}
              onChange={(e) => {
                setBasis(asBasis(e.target.value))
                setAgreementConfirmed(false)
              }}
              disabled={control.state !== 'choice'}
            >
              {BASES.map((b) => (
                <option key={b} value={b}>
                  {b === 'statutory_apr_mar' ? t('vacation_year_statutory_apr_mar') : t('vacation_year_calendar')}
                </option>
              ))}
            </SettingsSelect>
            <SettingsRowNote className="tabular-nums">
              {t('vacation_year_current', {
                start: formatDate(currentVacationYear.start),
                end: formatDate(currentVacationYear.end),
              })}
            </SettingsRowNote>
            {agreementPrompt !== 'none' && <SettingsRowNote>{t('vacation_year_agreement_note')}</SettingsRowNote>}
            {agreementPrompt === 'confirm' && (
              <div className="flex items-start gap-2">
                <Checkbox
                  id="vacation_year_agreement"
                  checked={agreementConfirmed}
                  onCheckedChange={(checked) => setAgreementConfirmed(checked === true)}
                  className="mt-0.5"
                />
                <Label htmlFor="vacation_year_agreement" className="text-xs font-normal leading-5 text-muted-foreground">
                  {t('vacation_year_agreement_confirm')}
                </Label>
              </div>
            )}
            {control.state === 'locked' && (
              <SettingsRowNote>
                {control.reason === 'open_balances'
                  ? t('vacation_year_locked_open_balances')
                  : t('vacation_year_locked_check_failed')}
              </SettingsRowNote>
            )}
          </div>
        </SettingsRow>
        <SettingsRow label={t('vacation_rule_label')} help={t('vacation_info')}>
          <Link
            href="/salary/employees"
            className="text-sm text-muted-foreground underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
          >
            {t('vacation_info_link')}
          </Link>
        </SettingsRow>
      </SettingsGroup>
    </SettingsFormWrapper>
  )
}
