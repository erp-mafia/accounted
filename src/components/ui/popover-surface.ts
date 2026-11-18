/**
 * The one look for everything that floats over the page: menus, comboboxes,
 * pickers, tooltips and popovers. Before
 * this existed, about twenty hand-positioned panels each picked their own
 * background (bg-card or bg-popover), border (border-input, border-border/60)
 * and Tailwind shadow. Stil v3: the floating layer (bg-popover, one step up
 * in dark), 10px radius, no border; the float shadow carries its own
 * hairline edge. Hand-positioned panels compose these constants;
 * check:guards rejects raw Tailwind shadow utilities in UI code.
 */
export const POPOVER_SURFACE_CLASS =
  'rounded-pop bg-popover text-popover-foreground shadow-float'

/** Entry for a hand-positioned panel that opens below its trigger. */
export const POPOVER_ENTER_CLASS = 'animate-in fade-in-0 zoom-in-98 slide-in-from-top-1 duration-150'

/** Entry for a hand-positioned panel that opens above its trigger. */
export const POPOVER_ENTER_UP_CLASS = 'animate-in fade-in-0 zoom-in-98 slide-in-from-bottom-1 duration-150'

/** Entry/exit for Radix content: the 4px slide follows the side it opened on. */
export const RADIX_POPOVER_MOTION_CLASS =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:zoom-in-98 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1'
