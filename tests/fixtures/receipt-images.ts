import { readFileSync } from 'node:fs'

export const receiptImageFormats = ['jpeg', 'png', 'webp'] as const
export type ReceiptImageFormat = typeof receiptImageFormats[number]

/**
 * Complete 8x8 images generated with sharp from RGB (73, 115, 191).
 * embedded-pdf.jpeg adds a valid JPEG COM segment containing %PDF-.
 * These are decodable files, not just magic-byte stubs or customer records.
 */
export function receiptImage(format: ReceiptImageFormat | 'embedded-pdf'): ArrayBuffer {
  const name = format === 'embedded-pdf' ? 'embedded-pdf.jpeg' : `receipt.${format}`
  const bytes = readFileSync(new URL(`./receipt-images/${name}`, import.meta.url))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
