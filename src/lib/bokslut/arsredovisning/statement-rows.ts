/**
 * ÅRL uppställningsform presentation rows for the årsredovisning PDF.
 *
 * Walks the row lists the digital filing prints (ixbrl/document/statements.ts)
 * with the same K2 risbs mapping (lib/bokslut/ixbrl/k2-mapper.ts): one list of
 * posts, labels and order per framework, one reading of what is hidden, so
 * the human-readable PDF and the iXBRL cannot diverge.
 *
 * Account numbers must never appear in these labels: Bolagsverket rejects
 * balans- och resultaträkningar that contain kontonummer; the statutory
 * uppställningsform (ÅRL bilaga 1-2) knows only posts, never BAS accounts.
 *
 * Sign conventions match the iXBRL document layer: every ConceptAmount is
 * oriented to the concept's natural balance, and cost/deduction posts get a
 * presentational minus (`displayMinus`) so the RR reads top-to-bottom as
 * intäkter − kostnader = resultat.
 */

import {
  K2_BALANSRAKNING_EGET_KAPITAL_SKULDER,
  K2_BALANSRAKNING_TILLGANGAR,
  K2_RESULTATRAKNING,
  K3_BALANSRAKNING_EGET_KAPITAL_SKULDER,
  K3_BALANSRAKNING_TILLGANGAR,
  K3_RESULTATRAKNING,
  foreningEquityAndLiabilities,
  printedRows,
  type StatementNode,
} from '@/lib/bokslut/ixbrl/document/statements'
import type { K2MappingResult } from '@/lib/bokslut/ixbrl/k2-mapper'
import { k3ConceptAmounts } from '@/lib/bokslut/ixbrl/k3-adapters'
import type { ConceptAmounts } from '@/lib/bokslut/ixbrl/types'
import type { StatementRow } from './types'

type StatementMapping = Pick<K2MappingResult, 'rr' | 'br' | 'totals'> &
  Partial<Pick<K2MappingResult, 'legalForm'>> & {
    /** 'k3': the mapping carries K3's own posts (k3-presentation.ts). Absent for K2. */
    presentation?: 'k3'
  }

/** Rows whose legal meaning other checks read, keyed by concept, never by label. */
const SEMANTIC_KEYS: Readonly<Record<string, StatementRow['semantic_key']>> = {
  AretsResultat: 'income_statement_result',
  AretsResultatEgetKapital: 'balance_sheet_current_year_result',
  Aktiekapital: 'balance_sheet_share_capital',
  Forlagsinsatser: 'balance_sheet_forlagsinsatser',
  EgetKapital: 'balance_sheet_equity_total',
}

/**
 * The PDF's rows of one list. A section sets its posts one step in; a
 * subsection two steps, its sum one, and that sum closes it.
 */
function statementRows(mapping: StatementMapping, nodes: readonly StatementNode[], amounts: ConceptAmounts): StatementRow[] {
  // The mapper leaves `previous` null on every concept when the company has no
  // previous fiscal year; any concept with a number means a jämförelseår exists.
  const hasPrevious = mapping.totals.tillgangar.previous !== null
  let inSubsection = false
  return printedRows(nodes, amounts, mapping.totals).map((row) => {
    if (row.kind === 'heading') {
      inSubsection = row.level === 'subsection'
      return { label: row.label, current: null, previous: null, is_heading: true, indent: inSubsection ? 1 : 0 }
    }
    const isTotal = row.kind === 'sum'
    const indent = isTotal ? (inSubsection ? 1 : 0) : row.indent === false ? 0 : inSubsection ? 2 : 1
    if (isTotal) inSubsection = false
    const sign = row.displayMinus ? -1 : 1
    const semanticKey = SEMANTIC_KEYS[row.concept]
    return {
      label: row.label,
      current: sign * row.amount.current,
      previous: hasPrevious ? sign * (row.amount.previous ?? 0) : null,
      ...(semanticKey ? { semantic_key: semanticKey } : {}),
      ...(isTotal ? { is_total: true } : {}),
      ...(indent ? { indent } : {}),
    }
  })
}

/** The amounts under the framework's own concept names: K3 renames three K2 posts. */
function conceptAmounts(mapping: StatementMapping): Pick<StatementMapping, 'rr' | 'br'> {
  return mapping.presentation === 'k3' ? k3ConceptAmounts(mapping.rr, mapping.br) : mapping
}

/** Resultaträkning: kostnadsslagsindelad per ÅRL bilaga 2, in uppställningsform order. */
export function buildRrRows(mapping: StatementMapping): StatementRow[] {
  const nodes = mapping.presentation === 'k3' ? K3_RESULTATRAKNING : K2_RESULTATRAKNING
  return statementRows(mapping, nodes, conceptAmounts(mapping).rr)
}

/** Balansräkning per ÅRL bilaga 1, in the company's equity layout. */
export function buildBrRows(mapping: StatementMapping): {
  assets: StatementRow[]
  equityLiabilities: StatementRow[]
} {
  const k3 = mapping.presentation === 'k3'
  const { br } = conceptAmounts(mapping)
  const equity = k3 ? K3_BALANSRAKNING_EGET_KAPITAL_SKULDER : K2_BALANSRAKNING_EGET_KAPITAL_SKULDER
  return {
    assets: statementRows(mapping, k3 ? K3_BALANSRAKNING_TILLGANGAR : K2_BALANSRAKNING_TILLGANGAR, br),
    equityLiabilities: statementRows(
      mapping,
      mapping.legalForm === 'ekonomisk_forening' ? foreningEquityAndLiabilities(equity) : equity,
      br,
    ),
  }
}
