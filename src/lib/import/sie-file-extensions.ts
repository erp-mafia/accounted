/**
 * Accepted SIE file extensions.
 *
 * The SIE 4B spec gives export files the `.SE` extension and import files
 * (SIE4I, written by subsystems such as payroll or POS) the `.SI` one. Several
 * Swedish systems write `.sie` instead. All three are the same tagged text
 * format, so every surface that takes a SIE upload accepts all three.
 *
 * One list on purpose: the API route, the upload UI and the MCP upload tool
 * each used to carry their own literal, and they drifted (issue #2546: `.si`
 * was accepted by MCP but rejected by the dashboard; accounted#32: the
 * onboarding step still had `.se,.sie`). check:guards fails on a new
 * hand-written list outside this file.
 */
export const SIE_FILE_EXTENSIONS = ['.se', '.sie', '.si'] as const

/**
 * The same list as a pattern, for schemas that validate with a regex (zod
 * `.regex()` also publishes it as the OpenAPI `pattern` of the v1 endpoint).
 */
export const SIE_FILE_EXTENSION_PATTERN = new RegExp(
  `\\.(${SIE_FILE_EXTENSIONS.map((extension) => extension.slice(1)).join('|')})$`,
  'i',
)

/** The same list in a Swedish sentence. Keep in sync with the array above. */
export const SIE_FILE_EXTENSIONS_SV = '.se, .sie eller .si'

/** The same list in an English sentence. Keep in sync with the array above. */
export const SIE_FILE_EXTENSIONS_EN = '.se, .sie or .si'

/** True when `filename` ends in one of the accepted SIE extensions. */
export function hasSIEFileExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return SIE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

/**
 * True when `filename` has no extension at all, the way a SIE export ends up
 * when it is saved without its `.se` (seen 2026-10-12). The upload surfaces
 * name the fix for it: rename the file, since the name rule is the same on
 * every surface (the API and MCP reserve the upload from the name alone,
 * before any byte is read).
 */
export function lacksFileExtension(filename: string): boolean {
  return !/\.[a-z0-9]{1,5}$/i.test(filename)
}
