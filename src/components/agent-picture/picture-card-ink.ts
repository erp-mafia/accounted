/**
 * The ink of a picture card's name and of the line under it, by the card's
 * state, as text colour classes.
 *
 * A card that is not connected is quiet: both its lines are in the lowest
 * text tier (`text-muted-foreground`), which holds AA contrast on the panel
 * in the light and the dark theme. Text is never made quieter with an
 * opacity: an opacity on that tier takes it under AA. A card that needs
 * attention says so in the amber text ink.
 *
 * Pure: no DOM, no IO.
 */
import type { PictureLinkState } from '@/lib/agent-context/agent-picture'

export interface CardInk {
  /** The card's name. */
  name: string
  /** The line under the name. */
  detail: string
}

export function cardInk(state: PictureLinkState): CardInk {
  return {
    name: state === 'not_connected' ? 'text-muted-foreground' : 'text-strong',
    detail: state === 'needs_attention' ? 'text-attn' : 'text-muted-foreground',
  }
}
