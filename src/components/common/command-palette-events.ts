/**
 * The command palette is mounted lazily on first use, so the sidebar and
 * mobile triggers cannot hold a ref to it. They dispatch this window event
 * instead: LazyCommandPalette mounts the palette on it, and an already
 * mounted palette opens.
 */
export const COMMAND_PALETTE_OPEN_EVENT = 'accounted:command-palette:open'

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(COMMAND_PALETTE_OPEN_EVENT))
}

/** ⌘K on Mac, Ctrl+K elsewhere. The same chord toggles the palette closed. */
export function isCommandPaletteShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
}
