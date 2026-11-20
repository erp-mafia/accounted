/**
 * The optimistic override of a floating button's hidden state
 * (use-fab-hidden.tsx), kept free of React so it is tested on its own.
 */
export type FabOverride = {
  value: boolean
  /** The prop value the override stands in for. */
  against: boolean
  /** The prop has been seen at `against`, so its next change is the server's answer. */
  armed: boolean
}

/**
 * What the button shows for a prop and an override, and the override to keep.
 * The override ends once the prop has left the value it was set against.
 * Without that end, a hide (set against false) came back to life when the
 * settings switch showed the button again (prop back to false), and the
 * button stayed hidden until a full reload.
 */
export function resolveFabOverride(
  override: FabOverride | null,
  hidden: boolean,
): { override: FabOverride | null; effectiveHidden: boolean } {
  let next = override
  if (next && !next.armed && hidden === next.against) next = { ...next, armed: true }
  else if (next && next.armed && hidden !== next.against) next = null
  return { override: next, effectiveHidden: next && next.against === hidden ? next.value : hidden }
}

/**
 * The undo's own save has landed: an undo override that never saw the prop at
 * "hidden" ends here (the hide's refresh rendered after the undo's write, so
 * no refresh will bring "hidden"). Kept, it would arm on a later hide from the
 * settings row and keep the button shown against it. An armed one stays until
 * the undo's refresh brings the prop back to "shown".
 */
export function settleUndoOverride(override: FabOverride | null): FabOverride | null {
  return override && !override.armed ? null : override
}
