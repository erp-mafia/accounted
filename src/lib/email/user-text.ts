/**
 * Utilities for safely rendering user-authored text in outgoing emails.
 *
 * Company-editable email texts (see company_settings.invoice_email_texts)
 * are untrusted input: they must be escaped before interpolation into HTML
 * templates and kept single-line when used as mail headers.
 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Escape FIRST, then convert newlines, order matters: a '<br>' typed by the
// user must arrive escaped; only OUR <br> survives.
export function userTextToHtml(input: string): string {
  return escapeHtml(input).replace(/\r\n|\r|\n/g, '<br>')
}

// Mail-header hygiene: a subject must be a single line (header injection).
export function sanitizeSubjectLine(input: string): string {
  return input.replace(/[\r\n]+/g, ' ').trim()
}

// Fixed-set {x} substitution. Single pass: substituted VALUES are never
// re-scanned, so a customer named '{belopp}' stays literal. Unknown keys are
// left as-is so the user sees and fixes typos. Keys are matched after
// trim + toLowerCase (forgiving of '{ Förnamn }').
export function applyPlaceholders(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^{}]*)\}/g, (match, rawKey: string) => {
    const value = values[rawKey.trim().toLowerCase()]
    return value !== undefined ? value : match
  })
}
