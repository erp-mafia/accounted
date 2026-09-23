export type InvoiceFontFileFormat = 'ttf' | 'woff'

export function detectInvoiceFontFileFormat(
  bytes: Uint8Array,
): InvoiceFontFileFormat | null {
  if (bytes.byteLength < 4) return null

  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return 'ttf'
  }

  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (signature === 'true') return 'ttf'
  if (signature === 'wOFF') return 'woff'
  return null
}

export function getInvoiceFontContentType(format: InvoiceFontFileFormat): string {
  return format === 'ttf' ? 'font/ttf' : 'font/woff'
}

export function toInvoiceFontDataUrl(
  bytes: Uint8Array,
  format: InvoiceFontFileFormat,
): string {
  return `data:${getInvoiceFontContentType(format)};base64,${Buffer.from(bytes).toString('base64')}`
}
