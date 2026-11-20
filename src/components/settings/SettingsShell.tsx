'use client'

import { SettingsRail } from './SettingsRail'
import { SettingsProvider } from './useSettings'

/**
 * The settings page layout. Since the V7 shell (2026-11-14) the settings
 * sections are the Inställningar area's sidebar (DashboardNav draws
 * SettingsRail there, search included), so the page is the section's content
 * alone, stretched across the panel like every other page. A phone has no
 * sidebar: there the grouped section picker sits on top of the content.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <div className="space-y-6 md:space-y-0">
        <div className="md:hidden">
          <SettingsRail display="select" />
        </div>
        {/* One centred column for every settings page: rows read best at this
            measure, and a table in it gets the room it needs. */}
        <div className="mx-auto min-w-0 max-w-[880px] pb-12">{children}</div>
      </div>
    </SettingsProvider>
  )
}
