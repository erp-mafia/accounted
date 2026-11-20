/**
 * Whether the composer may take focus on its own when a start page mounts.
 *
 * Only where typing is the primary input. On a touch device a focused field
 * opens the on-screen keyboard over the page the person just arrived at, so
 * a coarse primary pointer never gets automatic focus (the same media query
 * the Inkorg focus view and the category chip use). No matchMedia at all
 * (server render, an old webview) means no automatic focus either.
 */
export function composerMayAutoFocus(
  matchMedia: ((query: string) => { matches: boolean }) | null | undefined,
): boolean {
  if (typeof matchMedia !== 'function') return false
  return !matchMedia('(pointer: coarse)').matches
}
