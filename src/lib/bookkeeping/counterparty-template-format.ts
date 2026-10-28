/**
 * Pure counterparty-template helpers: the display form of a normalized
 * counterparty name and the id convention that tells a counterparty template
 * from a catalog template. Client components import these from here;
 * counterparty-templates.ts re-exports them for its server callers.
 */

/** Swedish company suffixes that should be uppercased */
const UPPER_SUFFIXES = new Set(['ab', 'hb', 'kb', 'ek', 'ef', 'uf'])

/**
 * Capitalize a normalized counterparty name for display.
 * "telia sverige ab" → "Telia Sverige AB"
 */
export function formatCounterpartyName(name: string): string {
  return name
    .split(' ')
    .map(w => UPPER_SUFFIXES.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export const COUNTERPARTY_PREFIX = 'counterparty:'
export function isCounterpartyTemplateId(id: string): boolean { return id.startsWith(COUNTERPARTY_PREFIX) }
export function toCounterpartyTemplateId(id: string): string { return COUNTERPARTY_PREFIX + id }
