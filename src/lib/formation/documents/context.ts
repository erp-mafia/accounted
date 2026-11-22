/**
 * What a document builder knows besides the founder's answers: the date it
 * is printed, the date the founders signed the stiftelseurkund (the
 * aktiebok and the first board decisions carry that date), and, once
 * Bolagsverket has registered the company, its organisation number,
 * registered name and registration date.
 */
export interface DocumentContext {
  /** ISO date (YYYY-MM-DD) the document is produced. */
  today: string
  /** ISO date the stiftelseurkund was signed, when known. */
  deedDate?: string | null
  registration?: { orgNumber: string; name: string; date: string } | null
}
