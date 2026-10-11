/**
 * Encoding detection and conversion for Swedish import files.
 *
 * Used by bank file, supplier, customer, and opening-balance parsers.
 * Swedish data exports use either UTF-8 or Windows-1252 (ISO-8859-1).
 * We detect encoding by checking for valid Swedish characters.
 */

import { hasMojibakeSignature, reverseMojibake } from '@/lib/bookkeeping/charset-repair'

/**
 * Decode file content, handling BOMs plus UTF-8 and Windows-1252 encodings.
 *
 * Strategy: inspect the leading BYTES first.
 * - FF FE / FE FF: UTF-16LE/BE (e.g. Excel "Unicode text" re-saves). Decode
 *   as such; TextDecoder consumes the BOM itself.
 * - EF BB BF (UTF-8 BOM): strip the three bytes and decode the REMAINDER.
 *   If the remainder still contains U+FFFD (invalid UTF-8 somewhere in the
 *   file), decode the remainder as Windows-1252. The BOM bytes are never
 *   re-included, so the fallback can no longer produce a literal mojibake
 *   "ï»¿" prefix that breaks exact-match header detection.
 * - No BOM: try UTF-8; fall back to Windows-1252 on replacement characters
 *   or garbled Swedish chars (unchanged behavior).
 */
export function decodeFileContent(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le', { fatal: false }).decode(buffer)
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be', { fatal: false }).decode(buffer)
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const rest = bytes.subarray(3)
    const utf8Rest = new TextDecoder('utf-8', { fatal: false }).decode(rest)
    if (!utf8Rest.includes('�')) {
      return utf8Rest
    }
    return new TextDecoder('windows-1252', { fatal: false }).decode(rest)
  }

  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
  const utf8Result = utf8Decoder.decode(buffer)

  if (!hasEncodingIssues(utf8Result)) {
    return utf8Result
  }

  const latin1Decoder = new TextDecoder('windows-1252', { fatal: false })
  return latin1Decoder.decode(buffer)
}

/**
 * Re-decode a string that suffered the canonical "UTF-8 bytes read as
 * Windows-1252" mojibake (e.g. "MalmÃ¶" → "Malmö", "GÃ–TEBORG" → "GÖTEBORG").
 *
 * The reversal is reverseMojibake (lib/bookkeeping/charset-repair), the one
 * definition: it maps each Windows-1252 character back to the byte it was
 * read from, which matters for uppercase Å/Ä/Ö, whose second UTF-8 byte
 * (0x85/0x84/0x96) reads as U+2026/U+201E/U+2013, far above 0xFF. Truncating those
 * code points to a byte destroyed the letter. The decode is strict, so a
 * string that is not a clean double encoding (already-correct text, a mix of
 * both) is returned unchanged rather than half-repaired.
 */
export function decodeStringContent(content: string): string {
  if (!hasMojibakeSignature(content)) return content
  return reverseMojibake(content) ?? content
}

/**
 * Check if a string has encoding issues (garbled Swedish characters).
 */
export function hasEncodingIssues(text: string): boolean {
  if (text.includes('\uFFFD')) return true

  // Common garbled patterns when Windows-1252 is read as UTF-8:
  // Ã¥ = å, Ã¤ = ä, Ã¶ = ö, Ã… = Å, Ã„ = Ä, Ã– = Ö
  const garbledPatterns = ['Ã¥', 'Ã¤', 'Ã¶', 'Ã\u0085', 'Ã\u0084', 'Ã\u0096']
  return garbledPatterns.some((pattern) => text.includes(pattern))
}

/**
 * Normalize line endings to \n
 */
export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * Strip BOM (Byte Order Mark) from start of content.
 *
 * Also strips the literal mojibake form "ï»¿" (U+00EF U+00BB U+00BF): a
 * UTF-8 BOM whose bytes were decoded as Windows-1252/Latin-1 upstream.
 * Covers string-entry paths that were pre-decoded outside decodeFileContent.
 */
export function stripBOM(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) {
    return content.slice(1)
  }
  if (content.startsWith('ï»¿')) {
    return content.slice(3)
  }
  return content
}

/**
 * Prepare file content for parsing: strip BOM, normalize line endings, handle encoding
 */
export function prepareContent(content: string): string {
  return normalizeLineEndings(stripBOM(decodeStringContent(content)))
}
