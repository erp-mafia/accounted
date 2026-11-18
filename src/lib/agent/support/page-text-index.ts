/**
 * The shape of the support assistant's page text index, shared by the script
 * that writes it (scripts/generate-support-page-texts.ts, run by the build)
 * and the reader that serves it (page-texts.ts).
 *
 * The index holds message KEYS per page, never the texts: the reader resolves
 * them against the message file of the user's locale, so the assistant quotes
 * the words on the user's own screen.
 */
export interface PageTextIndex {
  /** Source files that read messages, relative to src/. */
  files: string[]
  /** Per file (same position): the message keys it reads, in source order. */
  keys: string[][]
  /** Route pattern ("/invoices/[id]") -> positions in `files`: the page first, then what it imports, breadth first. */
  routes: Record<string, number[]>
}

/** A message file: nested objects with texts at the leaves. */
export type MessageTree = { [key: string]: string | MessageTree }

export const EMPTY_PAGE_TEXT_INDEX: PageTextIndex = { files: [], keys: [], routes: {} }

export function isPageTextIndex(value: unknown): value is PageTextIndex {
  if (!value || typeof value !== 'object') return false
  const index = value as Partial<PageTextIndex>
  return (
    Array.isArray(index.files) &&
    Array.isArray(index.keys) &&
    index.files.length === index.keys.length &&
    !!index.routes &&
    typeof index.routes === 'object'
  )
}
