import { cn } from '@/lib/utils'

/**
 * The look of a row in the area sidebar: 30px, 6px radius, 13px in the strong ink, a 10px gap after the
 * icon, the active row on the selected wash. Shared by the area
 * rows (AreaSidebar) and the Inställningar area's section rows (SettingsRail),
 * so the two cannot drift apart.
 */
export function navRowClass(active: boolean, opts?: { quiet?: boolean; disabled?: boolean }): string {
  return cn(
    'group flex h-7.5 items-center gap-2.5 rounded-md px-2 text-[13px] outline-none pointer-coarse:min-h-10',
    opts?.disabled
      ? 'cursor-not-allowed text-muted-foreground/60'
      : cn(
          'transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/70',
          active
            ? 'bg-secondary text-strong'
            : opts?.quiet
              ? 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
              : 'text-strong hover:bg-secondary/60',
        ),
  )
}

/** A row's leading glyph: 16px, a step quieter than the label. */
export const NAV_ROW_ICON_CLASS = 'h-4 w-4 flex-shrink-0 text-foreground/70 group-hover:text-foreground'

/** A group label over rows ("Register", "Styr", the settings groups): 12px/500, sentence case. */
export const NAV_GROUP_LABEL_CLASS = 'flex h-7 items-center px-2 text-[12px] font-medium text-muted-foreground'
