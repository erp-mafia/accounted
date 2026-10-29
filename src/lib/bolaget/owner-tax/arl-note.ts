/**
 * The annual report note on loans and security to the board and the VD
 * (ÅRL 5:18, which ÅRL 5:1 applies to smaller companies too; Bolaget
 * research brief, section 10). From the owner loan register: the loans the
 * company gave, and the security it put up, for a board member or
 * suppleant, or the VD or vice VD, owed on the balance day, per category,
 * with the interest and the main terms. No names: the note gives amounts
 * per category.
 *
 * Exposed for the årsredovisning to read (loadBoardLoansNote); it is not
 * wired into the årsredovisning builder yet. Pure: the loader in view.ts
 * reads the register and the roles.
 */
import { roundOre } from '@/lib/money'
import type { LoanKind } from './types'

export type BoardNoteCategory = 'board' | 'ceo'

export interface BoardNoteLoan {
  kind: LoanKind
  /** Owed (loan) or secured (security) on the balance day. */
  amount: number
  interest_rate: number | null
  terms: string | null
  category: BoardNoteCategory
}

export interface BoardNoteCategoryTotals {
  category: BoardNoteCategory
  label_sv: string
  loans_total: number
  securities_total: number
  items: Array<{ kind: LoanKind; amount: number; interest_rate: number | null; terms: string | null }>
}

export interface BoardLoansNote {
  balance_date: string
  /** False when the company has no such loan or security: no note is needed. */
  applicable: boolean
  heading_sv: string
  categories: BoardNoteCategoryTotals[]
  text_sv: string | null
}

const CATEGORY_LABELS_SV: Record<BoardNoteCategory, string> = {
  board: 'styrelseledamöter och styrelsesuppleanter',
  ceo: 'verkställande direktör och vice verkställande direktör',
}

function kr(n: number): string {
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(n).replace(/\u00a0/g, ' ')} kr`
}

function pct(n: number): string {
  return `${new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 2 }).format(n)} %`
}

export const BOARD_LOANS_NOTE_HEADING_SV = 'Lån, säkerheter och ansvarsförbindelser till förmån för styrelseledamöter och verkställande direktör'

export function buildBoardLoansNote(balanceDate: string, loans: readonly BoardNoteLoan[]): BoardLoansNote {
  const categories: BoardNoteCategoryTotals[] = (['board', 'ceo'] as const)
    .map((category) => {
      const items = loans.filter((l) => l.category === category && l.amount > 0)
      return {
        category,
        label_sv: CATEGORY_LABELS_SV[category],
        loans_total: roundOre(items.filter((l) => l.kind === 'loan').reduce((n, l) => n + l.amount, 0)),
        securities_total: roundOre(items.filter((l) => l.kind === 'security').reduce((n, l) => n + l.amount, 0)),
        items: items.map((l) => ({ kind: l.kind, amount: roundOre(l.amount), interest_rate: l.interest_rate, terms: l.terms })),
      }
    })
    .filter((c) => c.items.length > 0)

  if (categories.length === 0) {
    return { balance_date: balanceDate, applicable: false, heading_sv: BOARD_LOANS_NOTE_HEADING_SV, categories, text_sv: null }
  }

  const sentences: string[] = []
  for (const c of categories) {
    if (c.loans_total > 0) {
      const loanItems = c.items.filter((i) => i.kind === 'loan')
      const terms = loanItems
        .map((i) => {
          const parts = [i.interest_rate !== null ? `räntesats ${pct(i.interest_rate)}` : 'ingen avtalad ränta']
          if (i.terms) parts.push(`villkor: ${i.terms.replace(/\s+/g, ' ').trim().replace(/[.]$/, '')}`)
          return `${kr(i.amount)} (${parts.join(', ')})`
        })
        .join('; ')
      sentences.push(`Per ${balanceDate} har bolaget lämnat lån till ${c.label_sv} med sammanlagt ${kr(c.loans_total)}: ${terms}.`)
    }
    if (c.securities_total > 0) {
      sentences.push(`Bolaget har ställt säkerhet för ${c.label_sv} med sammanlagt ${kr(c.securities_total)}.`)
    }
  }
  return { balance_date: balanceDate, applicable: true, heading_sv: BOARD_LOANS_NOTE_HEADING_SV, categories, text_sv: sentences.join(' ') }
}
