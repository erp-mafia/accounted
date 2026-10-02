'use client'

import { SettingsRail } from './SettingsRail'
import { SettingsProvider } from './useSettings'

/**
 * The settings page layout: the section rail (with search) on the left and
 * the section content stretched across the rest of the panel, like every
 * other page. Settings opened as a 920x680 modal until 2026-09-24; it is a
 * full page since (founder decision), so the rail stays pinned under the
 * top bar while the content scrolls with the panel.
 */
export function SettingsShell({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <div className="grid gap-8 md:grid-cols-[232px_minmax(0,1fr)]">
        <aside className="md:sticky md:top-16 md:max-h-[calc(100vh-7rem)] md:self-start md:overflow-y-auto md:border-r md:border-border md:pr-4">
          <div className="md:hidden">
            <SettingsRail display="select" />
          </div>
          <div className="hidden md:block">
            <SettingsRail display="rail" />
          </div>
        </aside>
        <div className="min-w-0 pb-12">{children}</div>
      </div>
    </SettingsProvider>
  )
}
