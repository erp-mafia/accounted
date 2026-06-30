/**
 * Shared encoding helpers for Skatteverket SRU files.
 *
 * SRU submissions (INFO.SRU + BLANKETTER.SRU) must be ISO 8859-1 (Latin-1),
 * never UTF-8 — Swedish characters (å, ä, ö) corrupt otherwise and Skatteverkets
 * filöverföringstjänst rejects the upload. This is the single most common cause
 * of programmatic SRU validation failure.
 */

/**
 * Encode a string as ISO 8859-1 (Latin-1) bytes.
 * Characters outside the Latin-1 range (> 0xFF) are replaced with '?' (0x3F).
 */
export function encodeISO88591(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    bytes[i] = code <= 0xff ? code : 0x3f
  }
  return bytes
}
