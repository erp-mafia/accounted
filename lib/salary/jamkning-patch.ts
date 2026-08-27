/**
 * Decides whether an employee edit form sends the three jämkning keys
 * (jamkning_percentage / jamkning_valid_from / jamkning_valid_to) in its
 * PATCH body.
 *
 * The PATCH routes spread the body into the UPDATE, so an explicit null
 * clears the stored beslut. That is what we want when the user emptied the
 * percentage on screen, and exactly what we must avoid when the fields were
 * hidden (F-skatt, FA-skatt, ej verifierad, sidoinkomst) or simply not
 * touched: a beslut entered from a Skatteverket paper decision, possibly via
 * the API or MCP, must survive an unrelated edit. The engine still applies a
 * stored beslut for FA-skatt, and for A-skatt it applies again as soon as
 * sidoinkomst is unticked, so the row is left alone in every hidden case.
 */

export interface JamkningFormState {
  f_skatt_status: string
  is_sidoinkomst: boolean
  jamkning_percentage: number | null
  jamkning_valid_from: string | null
  jamkning_valid_to: string | null
  /** True once the user edited any of the three jämkning inputs this session. */
  jamkning_touched: boolean
}

export interface JamkningPatch {
  jamkning_percentage: number | null
  jamkning_valid_from: string | null
  jamkning_valid_to: string | null
}

/** The jämkning inputs are rendered only in this branch of the tax card. */
export function isJamkningEditable(state: Pick<JamkningFormState, 'f_skatt_status' | 'is_sidoinkomst'>): boolean {
  return state.f_skatt_status === 'a_skatt' && !state.is_sidoinkomst
}

/**
 * Returns the three keys (explicit values, null = clear) when the fields were
 * both visible and edited; otherwise an empty object so the sparse patch
 * leaves the stored beslut untouched. Spread the result into the body.
 */
export function jamkningPatch(state: JamkningFormState): JamkningPatch | Record<string, never> {
  if (!isJamkningEditable(state) || !state.jamkning_touched) return {}
  return {
    jamkning_percentage: state.jamkning_percentage,
    jamkning_valid_from: state.jamkning_valid_from,
    jamkning_valid_to: state.jamkning_valid_to,
  }
}
