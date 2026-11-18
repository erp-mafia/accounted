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
  /**
   * Per file (same position): what each key is on the page, one character per
   * key of `keys` (PAGE_TEXT_ROLES), `-` where the source does not show it.
   * Absent in an index written before roles existed: every text is then
   * without a role.
   */
  roles?: string[]
  /** Route pattern ("/invoices/[id]") -> positions in `files`: the page first, then what it imports, breadth first. */
  routes: Record<string, number[]>
}

/**
 * What a text is on the page, as far as the source shows it: the element it
 * is rendered in (a button, a tab, a heading), the attribute it is given to
 * (a placeholder), or the table it is looked up in (TAB_LABEL_KEYS). The word
 * is what the assistant is shown after the text; a text without a role is one
 * whose role the source does not tell, and the assistant may not guess it.
 */
export const PAGE_TEXT_ROLES = {
  b: 'knapp',
  t: 'flik',
  h: 'rubrik',
  f: 'fält',
  p: 'platshållare',
  c: 'kolumn',
  m: 'menyval',
  o: 'val',
  l: 'länk',
  d: 'hjälptext',
  s: 'status',
} as const

export type PageTextRole = keyof typeof PAGE_TEXT_ROLES

export const NO_PAGE_TEXT_ROLE = '-'

export function isPageTextRole(code: string | undefined): code is PageTextRole {
  return !!code && code in PAGE_TEXT_ROLES
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
    (index.roles === undefined || (Array.isArray(index.roles) && index.roles.length === index.keys.length)) &&
    !!index.routes &&
    typeof index.routes === 'object'
  )
}
