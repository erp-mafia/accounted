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
 * was accepted by MCP but rejected by the dashboard).
 */
export const SIE_FILE_EXTENSIONS = ['.se', '.sie', '.si'] as const

/** The same list in a Swedish sentence. Keep in sync with the array above. */
export const SIE_FILE_EXTENSIONS_SV = '.se, .sie eller .si'

/** The same list in an English sentence. Keep in sync with the array above. */
export const SIE_FILE_EXTENSIONS_EN = '.se, .sie or .si'

/** True when `filename` ends in one of the accepted SIE extensions. */
export function hasSIEFileExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return SIE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
