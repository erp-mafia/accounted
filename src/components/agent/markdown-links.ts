/**
 * Is this href a link back into the app?
 *
 * Kept out of MarkdownMessage so it is testable without the markdown parser
 * (that component exists to be lazily imported, and this repo's unit project
 * is node-only).
 *
 * The href comes from a language model that reads customer documents and
 * supplier invoices, so "starts with a slash" is not a sufficient test:
 * "//evil.example" is protocol-relative and leaves the site entirely. Anything
 * this returns false for is rendered as an external link, which is the safe
 * direction to be wrong in: an external link that could have been routed
 * costs a page load, whereas an external URL treated as internal would be
 * handed to the router as an app path.
 */
export function isInternalHref(href: string): boolean {
  if (!href.startsWith('/')) return false
  // Protocol-relative ("//host/path"), and the backslash variant browsers
  // normalise to the same thing.
  if (href.startsWith('//') || href.startsWith('/\\')) return false
  return true
}
