'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CompanySettings } from '@/types'

interface PeriodLockingSettingsProps {
  settings: CompanySettings
}

export function PeriodLockingSettings({ settings }: PeriodLockingSettingsProps) {
  const t = useTranslations('settings_period_locking')
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        {t('heading')}
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="space-y-2">
          <Label htmlFor="bookkeeping_locked_through">{t('locked_through_label')}</Label>
          <Input
            id="bookkeeping_locked_through"
            name="bookkeeping_locked_through"
            type="date"
            defaultValue={settings.bookkeeping_locked_through || ''}
          />
          <p className="text-xs text-muted-foreground">
            {t('locked_through_help')}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="auto_lock_period_days">{t('auto_lock_label')}</Label>
          <Select
            name="auto_lock_period_days"
            defaultValue={settings.auto_lock_period_days?.toString() || 'none'}
          >
            <SelectTrigger id="auto_lock_period_days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t('auto_lock_none')}</SelectItem>
              <SelectItem value="30">{t('auto_lock_30')}</SelectItem>
              <SelectItem value="60">{t('auto_lock_60')}</SelectItem>
              <SelectItem value="90">{t('auto_lock_90')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t('auto_lock_help')}
          </p>
        </div>
      </div>
    </section>
  )
}
