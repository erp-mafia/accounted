import { isAllowedInboxFile } from '@/lib/documents/upload-types'
import type { InkorgView } from './items'

/**
 * Whether a file dropped anywhere on the Inkorg page goes up as Ladda upp
 * sends it. Saknar underlag keeps its own drop: a file there is a purchase's
 * underlag, dropped on that purchase (missing.ts), never a loose upload.
 */
export function pageDropUploads(view: InkorgView): boolean {
  return view.kind !== 'missing'
}

/**
 * A page drop split into the files the inbox upload takes and the ones its
 * route would refuse for their type. A drop skips the picker's `accept`
 * filter, so a Word file, a zip or a folder (no type) can arrive with the
 * receipts; those are counted, not sent. The check is the route's own
 * (isAllowedInboxFile).
 */
export function splitPageDrop<T extends { type?: string | null }>(files: readonly T[]): { upload: T[]; refused: T[] } {
  const upload: T[] = []
  const refused: T[] = []
  for (const file of files) (isAllowedInboxFile(file) ? upload : refused).push(file)
  return { upload, refused }
}
