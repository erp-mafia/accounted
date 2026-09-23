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
    const path = parsed.pathname + parsed.search + parsed.hash
    // Re-check the NORMALISED path, not just the raw input. Dot-segment
    // resolution turns several innocent-looking inputs into a
    // protocol-relative one: `/..//evil.com`, `/.//evil.com` and
    // `/%2e%2e//evil.com` all normalise to `//evil.com`, and
    // `/a/../@evil.com` normalises to `/@evil.com`. Those keep the
    // sentinel origin above (they are relative to it), so the origin check
    // passes, but the returned string navigates off-origin the moment a
    // caller uses it as a bare href (window.location.assign, router.push).
    // Every prefix the raw-input guard rejects is re-rejected here, in
    // normal form, so the post-check cannot itself be re-normalised around.
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.startsWith('/\\') ||
      path.startsWith('/@')
    ) {
      return fallback
    }
    return path
  } catch {
    return fallback
  }
}
