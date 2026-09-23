import { readFileSync } from 'node:fs'

export const receiptImageFormats = ['jpeg', 'png', 'webp'] as const
export type ReceiptImageFormat = typeof receiptImageFormats[number]

/**
 * Complete 8x8 images generated with sharp from RGB (73, 115, 191).
 * embedded-pdf.jpeg adds a valid JPEG COM segment containing %PDF-.
 * receipt.heic is receipt.jpeg at 64x64, re-encoded by macOS sips (HEVC in HEIF).
 * These are decodable files, not just magic-byte stubs or customer records.
 */
// 'heic' is not in receiptImageFormats: the declared-versus-detected matrices are about formats the archive re-encodes.
export function receiptImage(format: ReceiptImageFormat | 'embedded-pdf' | 'heic'): ArrayBuffer {
  const name = format === 'embedded-pdf' ? 'embedded-pdf.jpeg' : `receipt.${format}`
  const bytes = readFileSync(new URL(`./receipt-images/${name}`, import.meta.url))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
