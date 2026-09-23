/**
 * Entry-level verifikationstext handling for the correction dialog.
 *
 * The correction header defaults server-side to "Rättelse: <original>"
 * (lib/core/bookkeeping/storno-service.ts). If the original entry was
 * labelled after the wrong account (e.g. "Lån från närstående personer,
 * långfristig del"), that header keeps echoing the wrong label even after
 * the account itself is corrected (issue #1031). The dialog therefore
 * pre-fills an editable field with the same auto text and only sends a
 * description when the user actually changed it: an untouched auto prefill
 * is omitted from the request so the server-side fallback stays the single
 * source of truth for the default format. Same only-overwrite-auto-filled
 * principle as the line-description guard from #1029.
 */

/** The auto text the server would generate for the correction header. */
export function autoCorrectionDescription(originalDescription: string): string {
  return `Rättelse: ${originalDescription}`
}

/**
 * Decide what to send as the correction's description.
 * Returns undefined when the field is blank or still equals the auto prefill:
 * in both cases the server-side fallback should apply.
 */
export function correctionDescriptionForSubmit(
  currentDescription: string,
  originalDescription: string,
): string | undefined {
  const trimmed = currentDescription.trim()
  if (!trimmed) return undefined
  if (trimmed === autoCorrectionDescription(originalDescription).trim()) return undefined
  return trimmed
}
