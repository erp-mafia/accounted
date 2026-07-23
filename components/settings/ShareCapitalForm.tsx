'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('share_capital_heading')}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="aktiekapital">{t('aktiekapital_label')}</Label>
          <Input
            id="aktiekapital"
            name="aktiekapital"
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={aktiekapital}
            onChange={(e) => setAktiekapital(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('aktiekapital_help')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="antal_aktier">{t('antal_aktier_label')}</Label>
          <Input
            id="antal_aktier"
            name="antal_aktier"
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={antalAktier}
            onChange={(e) => setAntalAktier(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t('antal_aktier_help')}</p>
        </div>
      </div>

      {kvotvarde !== null && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {t('kvotvarde_display', { value: formatCurrency(kvotvarde) })}
        </p>
      )}
    </section>
  )
}
