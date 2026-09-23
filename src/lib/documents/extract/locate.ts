import type { WordBox } from '@/lib/documents/read/types'
import type { Box } from './fields'

/** A stored page as the grounding step needs it. */
export interface PageText {
  pageNo: number
  text: string
  words: WordBox[] | null
}

const tokens = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

/**
 * Ground a quote: the page whose text contains it (the model's page claim is
 * tried first and corrected when wrong) and, when the page was read locally,
 * the region covering the quoted words. A quote the model paraphrased falls
 * back to its first half; one that matches nowhere keeps the claimed page.
 */
export function locateQuote(pages: PageText[], quote: string | null, claimedPage: number | null): { page: number | null; bbox: Box | null } {
  const quoted = quote ? tokens(quote) : []
  if (quoted.length === 0) return { page: claimedPage, bbox: null }
  const claimedFirst = [...pages].sort((a, b) => Number(b.pageNo === claimedPage) - Number(a.pageNo === claimedPage) || a.pageNo - b.pageNo)
  const needles = quoted.length >= 4 ? [quoted, quoted.slice(0, Math.ceil(quoted.length / 2))] : [quoted]
  for (const needle of needles) {
    const page = claimedFirst.find((p) => indexOfRun(tokens(p.text), needle) !== -1)
    if (page) return { page: page.pageNo, bbox: page.words ? boxFor(page.words, needle) : null }
  }
  return { page: claimedPage, bbox: null }
}

/** Where `needle` first occurs as a contiguous run in `haystack`, or -1. */
function indexOfRun(haystack: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, k) => haystack[i + k] === t)) return i
  }
  return -1
}

/** The union of the boxes of the text runs the quoted words fall in. */
function boxFor(words: WordBox[], needle: string[]): Box | null {
  const flat = words.flatMap((w, run) => tokens(w.t).map((t) => ({ t, run })))
  const start = indexOfRun(flat.map((f) => f.t), needle)
  if (start === -1) return null
  const boxes = [...new Set(flat.slice(start, start + needle.length).map((f) => f.run))].map((run) => words[run])
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  }
}
