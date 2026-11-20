import type { ReactNode } from 'react'

interface DashboardContentProps {
  /**
   * Streamed sections (server components behind Suspense in
   * app/(dashboard)/page.tsx): the notice line and the Att göra pane. The
   * shell renders at once and each slot fills in as its queries resolve.
   */
  notices: ReactNode
  panes: ReactNode
}

/**
 * Hem's shell (Att göra V8, "calm Hem"): the degraded-state notice line
 * (lib/notices: one attn line, highest priority first, a quiet "+N till"),
 * then the pane. The pane opens with the date and the headline, a template
 * filled with counts, and carries Kom igång, Först, Behöver dig, Rutin,
 * Fortsätt and the connections (components/dashboard/AttGoraSection).
 * The greeting left the page with V8: the headline says how things stand.
 */
export default function DashboardContent({ notices, panes }: DashboardContentProps) {
  return (
    <div className="space-y-8">
      {notices}
      {panes}
    </div>
  )
}
