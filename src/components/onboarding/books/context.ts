import type { Dispatch } from 'react'
import type { BooksFindings } from '@/lib/onboarding/findings'
import type { BooksAction, BooksFlags, BooksState } from '@/lib/onboarding-books/reducer'

/** What every step of the books act receives from the shell. */
export interface BooksCtx {
  state: BooksState
  dispatch: Dispatch<BooksAction>
  flags: BooksFlags
  findings: BooksFindings | null
  loadingFindings: boolean
  loadFindings: () => Promise<BooksFindings | null>
  /** Error text a redirect brought back (?bank_error=, ?skv_error=). */
  landedError: string | null
}
