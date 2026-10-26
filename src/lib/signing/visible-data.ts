/**
 * What a BankID signature binds. userVisibleData is shown in the BankID app
 * (simpleMarkdownV1) and says what the signer signs; userNonVisibleData rides
 * in the signature unseen and carries the document's SHA-256 and our ids, so
 * the signature is tied to exactly that file (eIDAS art. 26(d): any later
 * change is detectable). TIC's own advice: the summary visible, the document
 * hash in the hidden part.
 */

export interface SignedPayload {
  v: 1
  kind: 'accounted.signing'
  request: string
  signer: string
  /** SHA-256 of the PDF the signer signs. */
  sha256: string
  /** For an årsredovisning: the locked version's content hash. */
  content_hash?: string
}

/**
 * Text from people (titles, names, file names) inside simpleMarkdownV1: one
 * line, without the characters that start formatting, and no trailing space
 * (some BankID app versions fail on a space after bold).
 */
export function markdownSafe(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[*|#+]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export interface VisibleDataInput {
  title: string
  companyName: string
  fileName: string
  sha256: string
  signerName: string
  roleLabel?: string | null
  /** Replaces the default statement, e.g. the board's årsredovisning wording. */
  statement?: string
}

export function buildUserVisibleData(input: VisibleDataInput): string {
  const statement = input.statement
    ? markdownSafe(input.statement)
    : `Jag signerar *${markdownSafe(input.title)}* för ${markdownSafe(input.companyName)}.`
  const lines = [
    '# Signera dokument',
    '',
    statement,
    '',
    `+ Undertecknare: ${markdownSafe(input.signerName)}${input.roleLabel ? `, ${markdownSafe(input.roleLabel)}` : ''}`,
    `+ Fil: ${markdownSafe(input.fileName)}`,
    `+ Kontrollsumma (SHA-256): ${input.sha256.slice(0, 16)}`,
  ]
  return lines.join('\n')
}

export function buildUserNonVisibleData(payload: SignedPayload): string {
  return JSON.stringify(payload)
}

/**
 * Whether a BankID signature (XML-DSig, base64 as TIC answers it) binds our
 * userNonVisibleData. BankID carries it base64-encoded in usrNonVisibleData;
 * the raw form is accepted too. Not a cryptographic verification of the
 * signature (the XML and the OCSP response are stored for that); it refuses a
 * signature of anything else.
 */
export function signatureBindsPayload(signatureXmlBase64: string, userNonVisibleData: string): boolean {
  const carried = signedElement(signatureXmlBase64, 'usrNonVisibleData')
  if (carried === null) return false
  if (carried === userNonVisibleData) return true
  return Buffer.from(carried, 'base64').toString('utf8') === userNonVisibleData
}

/**
 * The text the BankID app showed, as the signature carries it (base64 in
 * usrVisibleData): the record of what the signer approved, read from the
 * signature itself rather than rebuilt. Null when the XML has none.
 */
export function signedVisibleText(signatureXmlBase64: string): string | null {
  const carried = signedElement(signatureXmlBase64, 'usrVisibleData')
  if (carried === null) return null
  const decoded = Buffer.from(carried, 'base64').toString('utf8')
  return decoded.trim() ? decoded : null
}

function signedElement(signatureXmlBase64: string, element: 'usrVisibleData' | 'usrNonVisibleData'): string | null {
  const xml = Buffer.from(signatureXmlBase64, 'base64').toString('utf8')
  const pattern = new RegExp(`<(?:[A-Za-z0-9]+:)?${element}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z0-9]+:)?${element}>`)
  const match = pattern.exec(xml)
  return match ? match[1]!.trim() : null
}
