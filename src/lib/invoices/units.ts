/**
 * The unit vocabulary offered on article and invoice lines.
 *
 * These are SUGGESTIONS, not validation. `unit` is stored as free text (all
 * four tables declare it `text`) and the API accepts any non-empty string up
 * to 32 characters (lib/api/schemas.ts), so a customer who sells fuel types
 * "l" and one who sells flooring types "m2" without a code change. The list
 * exists only so the common units are one keystroke away, and so the places
 * that offer them cannot drift apart again: before this module the same six
 * strings were pasted into ArticleForm, InvoiceEditor and
 * NewRecurringScheduleDialog, and a closed dropdown also made a unit that was
 * stored by any other route (API, CSV import, MCP) unreachable in the UI.
 *
 * Adding an entry here is enough for every surface. One thing must follow it:
 * lib/invoices/peppol-bis-billing.ts needs a UN/ECE Rec 20 code for the unit,
 * or a unit we suggested would fail the Peppol export with UNIT_UNSUPPORTED.
 * __tests__/units.test.ts pins that pairing.
 *
 * The strings stay Swedish in both locales: they are invoice data, not UI
 * chrome. lib/invoices/unit-labels.ts translates them at render time on an
 * English document.
 */
export const UNIT_SUGGESTIONS = ['st', 'tim', 'dag', 'månad', 'km', 'kg', 'l'] as const

export type UnitSuggestion = (typeof UNIT_SUGGESTIONS)[number]

/**
 * Shared id for the `<datalist>` that carries the suggestions. Several editors
 * can be mounted at once (an article dialog over the invoice editor); the
 * lists are identical, so the duplicate id resolving to the first one is
 * harmless.
 */
export const UNIT_DATALIST_ID = 'unit-suggestions'

/** Mirrors `unit`'s max length in lib/api/schemas.ts, so the input cannot produce a 400. */
export const UNIT_MAX_LENGTH = 32
