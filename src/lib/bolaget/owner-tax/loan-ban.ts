/**
 * The låneförbud (ABL 21 kap.) for one loan or security, as far as the
 * registers and what the user entered tell it. Conservative: a loan the
 * check cannot clear is flagged, never refused. Pure: no I/O.
 *
 * The circle (21:1): shareholders, board members and the VD of the company
 * or another company of its group; their spouses, cohabitants and certain
 * relatives; legal persons they control. Holders, board members (the
 * suppleanter too, conservatively) and the VD (and vice VD) are read from
 * the aktiebok and the roles; the rest comes from the loan's relation.
 *
 * The exceptions (21:2): a group company; a loan used only in the
 * borrower's business on purely commercial grounds; a shareholder holding
 * less than 1 % of the share capital (read from the aktiebok, and only when
 * being a shareholder is the borrower's only link). Skatteverket may grant
 * dispensation (21:8). Security for a loan is covered the same way (21:3).
 * Loans and security under the business-loan exception or a dispensation
 * go on the special list kept ten years (21:10).
 *
 * A loan the company takes from an owner is outside the förbud.
 */
import type { OperationWarning } from '@/lib/operations/types'
import { SPECIAL_LIST_EXCEPTIONS, type LoanDirection, type LoanException, type LoanKind, type LoanRelation } from './types'

export type LoanCircleLink = 'holder' | 'board' | 'ceo' | 'group_insider' | 'related_person' | 'controlled_entity'
export type LoanBanStatus = 'not_applicable' | 'outside_circle' | 'exception' | 'prohibited'
export type LoanBanException = Exclude<LoanException, 'none'> | 'small_holding'

/** Below this share of the capital a shareholder is outside the förbud (21:2), if that is their only link. */
export const SMALL_HOLDING_PCT = 1

export interface LoanBanInput {
  direction: LoanDirection
  kind: LoanKind
  relation: LoanRelation
  exception: LoanException
  party_kind: 'person' | 'company'
  /** The party's share of the capital in percent when it is a holder, else null. */
  holder_capital_pct: number | null
  is_board: boolean
  is_ceo: boolean
}

export interface LoanBanAssessment {
  status: LoanBanStatus
  circle: LoanCircleLink[]
  exception: LoanBanException | null
  /** Goes on the 21:10 special list. */
  special_list: boolean
  warnings: OperationWarning[]
}

function what(kind: LoanKind): { sv: string; en: string } {
  return kind === 'security' ? { sv: 'Säkerheten', en: 'The security' } : { sv: 'Lånet', en: 'The loan' }
}

export function assessLoanBan(input: LoanBanInput): LoanBanAssessment {
  if (input.direction === 'borrows') {
    return { status: 'not_applicable', circle: [], exception: null, special_list: false, warnings: [] }
  }
  const circle: LoanCircleLink[] = []
  if (input.holder_capital_pct !== null && input.holder_capital_pct > 0) circle.push('holder')
  if (input.is_board) circle.push('board')
  if (input.is_ceo) circle.push('ceo')
  if (input.relation !== 'none') circle.push(input.relation)
  if (circle.length === 0) {
    return { status: 'outside_circle', circle, exception: null, special_list: false, warnings: [] }
  }

  const w = what(input.kind)
  if (input.exception === 'group_company' && input.party_kind === 'person') {
    return {
      status: 'prohibited',
      circle,
      exception: null,
      special_list: false,
      warnings: [
        {
          code: 'LOAN_BAN_GROUP_EXCEPTION_PERSON',
          message_sv: `${w.sv} gäller en fysisk person: undantaget för koncernföretag (21 kap. 2 § ABL) gäller bara lån till ett annat bolag i koncernen.`,
          message_en: `${w.en} is to a natural person: the group company exception (ABL 21:2) only covers loans to another company of the group.`,
        },
      ],
    }
  }
  if (input.exception !== 'none') {
    const special = SPECIAL_LIST_EXCEPTIONS.includes(input.exception)
    return {
      status: 'exception',
      circle,
      exception: input.exception,
      special_list: special,
      warnings: special
        ? [
            {
              code: 'LOAN_SPECIAL_LIST',
              message_sv: `${w.sv} ska föras in i den särskilda förteckningen som bolaget upprättar för varje räkenskapsår och bevarar i tio år (21 kap. 10 § ABL).`,
              message_en: `${w.en} goes on the special list the company keeps for each financial year and retains for ten years (ABL 21:10).`,
            },
          ]
        : [],
    }
  }
  if (circle.length === 1 && circle[0] === 'holder' && input.holder_capital_pct !== null && input.holder_capital_pct < SMALL_HOLDING_PCT) {
    return { status: 'exception', circle, exception: 'small_holding', special_list: false, warnings: [] }
  }
  return {
    status: 'prohibited',
    circle,
    exception: null,
    special_list: false,
    warnings: [
      {
        code: 'LOAN_BAN_PROHIBITED',
        message_sv: `${w.sv} omfattas av låneförbudet i 21 kap. 1 § ABL (aktieägare, styrelseledamot, VD eller närstående). Kontrollera om ett undantag i 21 kap. 2 § gäller eller om Skatteverket har gett dispens (21 kap. 8 §). Ett förbjudet lån ska betalas tillbaka (21 kap. 11 §).`,
        message_en: `${w.en} falls under the loan prohibition in ABL 21:1 (shareholder, board member, VD or a related person). Check whether an exception in 21:2 applies or Skatteverket granted dispensation (21:8). A prohibited loan must be repaid (21:11).`,
      },
    ],
  }
}

export const LOAN_CIRCLE_LABELS_SV: Record<LoanCircleLink, string> = {
  holder: 'Aktieägare',
  board: 'Styrelseledamot',
  ceo: 'Verkställande direktör',
  group_insider: 'Insider i koncernbolag',
  related_person: 'Närstående',
  controlled_entity: 'Bolag som kontrolleras av en insider',
}
