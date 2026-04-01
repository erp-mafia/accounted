'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CompanySettings } from '@/types'

interface PeriodLockingSettingsProps {
  settings: CompanySettings
}

export function PeriodLockingSettings({ settings }: PeriodLockingSettingsProps) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
        Periodlåsning
      </h2>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <div className="space-y-2">
          <Label htmlFor="bookkeeping_locked_through">Bokföring låst t.o.m.</Label>
          <Input
            id="bookkeeping_locked_through"
            name="bookkeeping_locked_through"
            type="date"
            defaultValue={settings.bookkeeping_locked_through || ''}
          />
          <p className="text-xs text-muted-foreground">
            Verifikationer med datum före detta datum kan inte skapas eller ändras.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="auto_lock_period_days">Automatisk låsning efter</Label>
          <Select
            name="auto_lock_period_days"
            defaultValue={settings.auto_lock_period_days?.toString() || 'none'}
          >
            <SelectTrigger id="auto_lock_period_days">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Ingen automatisk låsning</SelectItem>
              <SelectItem value="30">30 dagar efter periodens slut</SelectItem>
              <SelectItem value="60">60 dagar efter periodens slut</SelectItem>
              <SelectItem value="90">90 dagar efter periodens slut</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Låser automatiskt perioder efter valt antal dagar.
          </p>
        </div>
      </div>
    </section>
  )
}
