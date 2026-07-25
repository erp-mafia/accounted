'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
} from '@/components/settings/SettingsRows'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'

// Deliberately narrow (data minimisation): the form only ever needs the two
// share-capital fields, not the whole CompanySettings object.
interface ShareCapitalFormProps {
  settings: {
    aktiekapital?: number | null
    antal_aktier?: number | null
  }
}

/**
 * Registered share capital per Bolagsverket, feeding the statutory
 * aktiekapital note in the annual report. Kvotvärde (ABL 1 kap 6 §:
 * aktiekapital / antal aktier) is derived, never entered.
 */
export function ShareCapitalForm({ settings }: ShareCapitalFormProps) {
  const t = useTranslations('settings_company')
  const [aktiekapital, setAktiekapital] = useState(
    settings.aktiekapital != null ? String(settings.aktiekapital) : '',
  )
  const [antalAktier, setAntalAktier] = useState(
    settings.antal_aktier != null ? String(settings.antal_aktier) : '',
  )

  const capital = Number(aktiekapital)
  const shares = Number(antalAktier)
  // Mirror UpdateSettingsSchema: whole-krona capital > 0, positive integer
  // share count. No preview for values the server would reject.
  const kvotvarde =
    Number.isSafeInteger(capital) && capital > 0 && Number.isSafeInteger(shares) && shares > 0
      ? roundOre(capital / shares)
      : null

  return (
    <SettingsGroup label={t('share_capital_heading')}>
      <SettingsRow
        label={t('aktiekapital_label')}
        htmlFor="aktiekapital"
        help={t('aktiekapital_help')}
        align="baseline"
      >
        <SettingsInput
          id="aktiekapital"
          name="aktiekapital"
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          value={aktiekapital}
          onChange={(e) => setAktiekapital(e.target.value)}
          required={antalAktier.trim() !== ''}
          className="max-w-32 flex-none tabular-nums"
        />
      </SettingsRow>
      <SettingsRow
        label={t('antal_aktier_label')}
        htmlFor="antal_aktier"
        help={t('antal_aktier_help')}
        align="baseline"
      >
        <SettingsInput
          id="antal_aktier"
          name="antal_aktier"
          type="number"
          inputMode="numeric"
          min="1"
          step="1"
          value={antalAktier}
          onChange={(e) => setAntalAktier(e.target.value)}
          required={aktiekapital.trim() !== ''}
          className="max-w-32 flex-none tabular-nums"
        />
        {kvotvarde !== null && (
          <SettingsRowEnd>
            <SettingsRowNote className="tabular-nums">
              {t('kvotvarde_display', { value: formatCurrency(kvotvarde) })}
            </SettingsRowNote>
          </SettingsRowEnd>
        )}
      </SettingsRow>
    </SettingsGroup>
  )
}
