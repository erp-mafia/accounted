'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { DashboardShell } from '@/types'

/**
 * Which dashboard shell the page renders in (user_preferences.ui_state.shell,
 * resolved once by the dashboard layout). Client pages read it with useShell()
 * to add the v2 columns, toolbars and panes; v1 stays the default so a page
 * rendered outside the provider is byte-identical to before.
 */
const ShellContext = createContext<DashboardShell>('v1')

export function ShellProvider({ shell, children }: { shell: DashboardShell; children: ReactNode }) {
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>
}

export function useShell(): DashboardShell {
  return useContext(ShellContext)
}
