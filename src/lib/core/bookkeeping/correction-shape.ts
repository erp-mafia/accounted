/**
 * Shape checks on a proposed rättelse against the verifikat it corrects,
 * pure so the engine (storno-service.ts correctEntry) and the doors that
 * pre-check before staging or a dry run give the same verdict.
 */

interface LineAmounts {
  account_number: string
  debit_amount?: number | string | null
  credit_amount?: number | string | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function netPerAccount(lines: LineAmounts[]): Map<string, number> {
  const nets = new Map<string, number>()
  for (const line of lines) {
    const delta = round2(Number(line.debit_amount) || 0) - round2(Number(line.credit_amount) || 0)
    nets.set(line.account_number, round2((nets.get(line.account_number) || 0) + delta))
  }
  return nets
}

/**
 * True when the proposed lines put, on every account, exactly the negative of
 * what the original put there: the original with debit and credit swapped,
 * however the lines are split or tagged. The storno of a correction already
 * reverses the original, so such a rättelse reverses it a second time and the
 * account ends at minus the original instead of zero (crm#1397: a 100 kr bank
 * fee reversed twice). It is right only when the original itself was booked
 * with the sides swapped, which the caller has to say (sidesSwapped).
 *
 * An original that nets to zero on every account is never "negated": its
 * negation is the net-zero rättelse, refused on its own.
 */
export function negatesOriginal(proposed: LineAmounts[], original: LineAmounts[]): boolean {
  const proposedNets = netPerAccount(proposed)
  const originalNets = netPerAccount(original)
  let originalMoves = false
  for (const [account, net] of originalNets) {
    if (Math.abs(net) >= 0.005) originalMoves = true
    if (Math.abs((proposedNets.get(account) || 0) + net) >= 0.005) return false
  }
  for (const [account, net] of proposedNets) {
    if (!originalNets.has(account) && Math.abs(net) >= 0.005) return false
  }
  return originalMoves
}
