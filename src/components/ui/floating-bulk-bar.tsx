import { cn } from '@/lib/utils'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'

/**
 * The bulk bar every list shares once something is selected: a pill floating
 * over the panel, centred, clear of the mobile bottom nav (#2738), so it stays
 * in view however far down the selection reaches and the list never shifts
 * under it. The transactions page had it first; the other lists carried an
 * inline strip at the top of the table that scrolled away.
 */
export const FLOATING_BULK_BAR_CLASS =
  'flex items-center gap-x-5 gap-y-2 text-[12.5px] animate-fade-in fixed bottom-[calc(var(--bottom-nav-h)+1rem)] left-1/2 z-30 max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-x-auto whitespace-nowrap rounded-full border border-border bg-background px-4 py-2 shadow-[var(--shadow-md)] md:left-[calc(50%+var(--nav-w)/2)]'

export function FloatingBulkBar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div {...PAGE_BOTTOM_BAR_PROPS} className={cn(FLOATING_BULK_BAR_CLASS, className)}>
      {children}
    </div>
  )
}
