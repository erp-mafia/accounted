/**
 * Where a v1 error code is documented.
 *
 * The public error catalogue is one page with an anchor per code: each entry's
 * heading id is the code in lowercase (`PERIOD_LOCKED` is `#period_locked`).
 * There is no page per code, so a code's `docs_url` is that anchor.
 *
 * next.config.ts imports this file, so it imports nothing.
 */

/** The error catalogue page on the docs site. */
export const ERROR_CATALOGUE_URL = 'https://docs.accounted.se/errors'

/** A stable error code as it can appear in a URL path segment. */
export const ERROR_CODE_SEGMENT = '[A-Za-z0-9_]+'

/** The catalogue entry for one code, e.g. `https://docs.accounted.se/errors#period_locked`. */
export function docsUrlFor(code: string): string {
  return `${ERROR_CATALOGUE_URL}#${code.toLowerCase()}`
}
