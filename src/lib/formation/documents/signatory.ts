/**
 * The signatory rule (firmateckning) as it is written in the board's
 * decision and typed into verksamt.se. The board can always sign for the
 * company; the founders can add that the members sign one by one or two
 * together (Bolagsverket "Firmateckning", checked 2026-11-19).
 */

import type { SignatoryRule } from '../answers'

export const SIGNATORY_RULE_TEXT: Record<SignatoryRule, string> = {
  board: 'Bolagets firma tecknas av styrelsen.',
  board_or_each: 'Bolagets firma tecknas av styrelsen. Firman tecknas även av styrelseledamöterna var för sig.',
  board_or_two: 'Bolagets firma tecknas av styrelsen. Firman tecknas även av två styrelseledamöter i förening.',
}

export function signatoryRuleText(rule: SignatoryRule): string {
  return SIGNATORY_RULE_TEXT[rule]
}
