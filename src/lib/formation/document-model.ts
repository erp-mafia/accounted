/**
 * A small, format-neutral model of a formation document (bolagsordning,
 * board minutes, aktiebok, answer sheet, ...). Builders in
 * `documents/*.ts` produce it from the founder's answers; `docx.ts` and
 * `pdf.ts` render the same model, so the Word and PDF copies never drift.
 */

export type DocBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string; muted?: boolean; bold?: boolean }
  | { kind: 'list'; items: string[]; ordered?: boolean }
  | { kind: 'table'; head: string[]; rows: string[][]; widths?: number[] }
  | { kind: 'fields'; rows: Array<{ label: string; value: string }> }
  | { kind: 'signatures'; people: Array<{ name: string; caption?: string }> }

export interface FormationDocument {
  /** File name stem, ASCII only: "bolagsordning", "styrelseprotokoll". */
  slug: string
  title: string
  /** One muted line under the title: the company name proposal and date. */
  subtitle?: string
  blocks: DocBlock[]
  /** A note printed at the foot of every page, e.g. that a draft needs review. */
  footer?: string
}
