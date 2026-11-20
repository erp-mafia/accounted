/**
 * Limits of an invoice's underlag (accounted#42), a leaf module so the
 * invoice page's section can read them without the server-side service.
 */

/** Documents one call may attach. */
export const MAX_UNDERLAG_PER_CALL = 25
/** Documents one invoice may rest on: keeps the list (and every read of it) bounded. */
export const MAX_UNDERLAG_PER_INVOICE = 100
