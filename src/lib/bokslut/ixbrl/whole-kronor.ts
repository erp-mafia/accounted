/**
 * Whole kronor, a half away from zero: how the årsredovisning rounds every
 * figure it prints and tags, in the statements (k2-mapper.ts) and in the
 * notes (arsredovisning/k2-fixed-asset-note.ts), so a figure reads the same
 * wherever it appears and whatever its sign.
 *
 * Pure, and a module of its own: the note's model is read in the browser
 * (the save schema), which must not pull in the mapper's BAS reference data.
 */
import { roundOre } from '@/lib/money'

export function roundWhole(amount: number): number {
  const normalized = roundOre(amount)
  const rounded = Math.round(Math.abs(normalized))
  return rounded === 0 ? 0 : Math.sign(normalized) * rounded
}
