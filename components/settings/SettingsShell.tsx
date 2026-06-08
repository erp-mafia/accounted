'use client'

import { Suspense } from 'react'
import { SettingsRail } from './SettingsRail'
import { SettingsLoadingSkeleton } from './SettingsLoadingSkeleton'
import { SettingsProvider } from './useSettings'
import { SETTINGS_SECTIONS } from './sections'

interface SettingsShellProps {
  variant: 'page' | 'modal'
  /** Resolved section id. Required for the modal (drives which content renders);
   *  optional for the page where `{children}` is the route's own content. */
  activeSection?: string
  children?: React.ReactNode
}

/**
 * Shared two-pane settings layout (category rail + content). The full-page
 * route renders it via `settings/layout.tsx` (content = the route's children);
 * the routed modal renders it inside a Dialog (content resolved from the
 * section map). Keeping one shell means page and modal stay visually identical.
 */
export function SettingsShell({ variant, activeSection, children }: SettingsShellProps) {
  if (variant === 'modal') {
    const Section = activeSection ? SETTINGS_SECTIONS[activeSection] : undefined
    return (
      // One provider per open shell: the section it wraps is swapped on tab change
      // without remounting the shell, so the settings fetch is shared across tabs.
      <SettingsProvider>
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-r border-border p-3 md:block">
            <SettingsRail variant="modal" display="rail" activeId={activeSection} />
          </aside>
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="mb-6 md:hidden">
              <SettingsRail variant="modal" display="select" activeId={activeSection} />
            </div>
            <Suspense fallback={<SettingsLoadingSkeleton />}>
              {Section ? <Section /> : null}
            </Suspense>
          </div>
        </div>
      </SettingsProvider>
    )
  }

  return (
    <SettingsProvider>
      <div className="grid gap-8 md:grid-cols-[220px_1fr]">
        <aside className="md:sticky md:top-8 md:self-start">
          <div className="mb-4 md:hidden">
            <SettingsRail variant="page" display="select" />
          </div>
          <div className="hidden md:block">
            <SettingsRail variant="page" display="rail" />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </SettingsProvider>
  )
}
