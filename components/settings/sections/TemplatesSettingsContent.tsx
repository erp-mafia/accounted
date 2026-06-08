'use client'

import { BookingTemplatesPanel } from '@/components/settings/BookingTemplatesPanel'
import { CounterpartyTemplatesPanel } from '@/components/settings/CounterpartyTemplatesPanel'

export function TemplatesSettingsContent() {
  return (
    <div className="space-y-8">
      <BookingTemplatesPanel />
      <CounterpartyTemplatesPanel />
    </div>
  )
}
