/**
 * Validate that a returnTo query param is a same-origin relative path.
 *
 * The previous guard only rejected protocol-relative URLs (`//evil.com`),
 * but `/\evil.com`, `/?@evil.com`, and various other forms can still
 * redirect off-origin in some browsers. Parse with a real URL and verify
 * the origin matches.
 *
 * Returns the normalised path-with-search-and-hash on success, or the
 * provided `fallback` if `value` is missing, malformed, or off-origin.
 */
export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  if (!value.startsWith('/')) return fallback
  // Reject protocol-relative and the two known browser-quirk forms.
  if (value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/@')) {
    return fallback
  }
  try {
    const base = 'https://gnubok.invalid'
    const parsed = new URL(value, base)
    if (parsed.origin !== base) return fallback
    return parsed.pathname + parsed.search + parsed.hash
  } catch {
    return fallback
  }
}
