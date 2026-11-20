import { cn } from '@/lib/utils'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'

/**
 * The bulk bar every list shares once something is selected (Stil v3): a
 * frosted floating bar over the panel, centred, clear of the mobile bottom
 * nav (#2738), so it stays in view however far down the selection reaches
 * and the list never shifts under it. "N markerade", a hairline, then the
 * actions (one primary). The transactions page had it first; the other
 * lists carried an inline strip at the top of the table that scrolled away.
 */
export const FLOATING_BULK_BAR_CLASS =
  'flex items-center gap-x-2.5 gap-y-2 text-[13px] animate-rise fixed bottom-[calc(var(--bottom-nav-h)+1.5rem)] left-1/2 z-30 max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-x-auto whitespace-nowrap rounded-pop bg-[var(--material)] py-2 pl-4 pr-2 shadow-float backdrop-blur-xl backdrop-saturate-[1.8] reduced-transparency:bg-popover reduced-transparency:backdrop-blur-none md:left-[calc(50%+var(--nav-w)/2)]'

export function FloatingBulkBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div {...PAGE_BOTTOM_BAR_PROPS} className={cn(FLOATING_BULK_BAR_CLASS, className)}>
      {children}
    </div>
  )
}
