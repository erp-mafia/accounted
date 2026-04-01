'use client'

import Link from 'next/link'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { PeriodLockingSettings } from '@/components/settings/PeriodLockingSettings'
import { VoucherSeriesManager } from '@/components/settings/VoucherSeriesManager'
import { useSettings } from '@/components/settings/useSettings'
import { Label } from '@/components/ui/label'
import { ExternalLink } from 'lucide-react'
import type { CompanySettings } from '@/types'

export default function BookkeepingSettingsPage() {
  const { settings, isLoading, updateSettings } = useSettings()

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

  function handleSave(formData: FormData) {
    const autoLockValue = formData.get('auto_lock_period_days') as string
    const lockedThrough = (formData.get('bookkeeping_locked_through') as string) || null
    const accountingMethod = (formData.get('accounting_method') as string) || 'accrual'

    const updates: Record<string, unknown> = {
      bookkeeping_locked_through: lockedThrough,
      auto_lock_period_days: autoLockValue === 'none' ? null : parseInt(autoLockValue),
      accounting_method: accountingMethod,
    }
    updateSettings(updates as Partial<CompanySettings>)
    return updates
  }

  return (
    <div className="space-y-8">
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        {/* Accounting method */}
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
            Bokföringsmetod
          </h2>
          <div className="space-y-2">
            <Label htmlFor="accounting_method">Metod</Label>
            <select
              id="accounting_method"
              name="accounting_method"
              defaultValue={settings.accounting_method || 'accrual'}
              className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="accrual">Faktureringsmetoden</option>
              <option value="cash">Kontantmetoden</option>
            </select>
            <p className="text-xs text-muted-foreground">
              {settings.entity_type === 'aktiebolag'
                ? 'Aktiebolag med omsättning över 3 MSEK måste använda faktureringsmetoden.'
                : 'Kontantmetoden är tillgänglig för enskild firma med omsättning under 3 MSEK.'}
            </p>
          </div>
        </section>

        {/* Period locking */}
        <div className="border-t border-border/8 pt-8">
          <PeriodLockingSettings settings={settings} />
        </div>
      </SettingsFormWrapper>

      {/* Voucher series — read-only, no form submit needed */}
      <div className="border-t border-border/8 pt-8">
        <VoucherSeriesManager />
      </div>

      {/* Cross-links */}
      <div className="border-t border-border/8 pt-8 space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Relaterat
        </h2>
        <div className="flex flex-col gap-2">
          <Link
            href="/bookkeeping"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Räkenskapsår och ingående balanser
          </Link>
          <Link
            href="/bookkeeping"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Kontoplan (BAS)
          </Link>
        </div>
      </div>
    </div>
  )
}
