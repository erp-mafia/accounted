import { isReverseChargeBasisAccount } from '@/lib/bookkeeping/vat-entries'
import type { RcBasisPairEvidence, RcBasisPairShape, SIEVoucher } from './types'

/**
 * How a SIE file's own vouchers report the reverse-charge basis of the
 * purchases on each cost account (crm#1096).
 *
 * The momsdeklaration reads ruta 20-24 from two places: the BAS basis accounts
 * by number (4415-4417, 4425-4427, 4515-4517, 4531-4537) and every class 4-6
 * account whose momskod in the kontoplan is a reverse-charge purchase. A
 * source system reports a purchase either way: on the cost account itself, or
 * on a separate pair beside it, the basis on a 44xx/45xx account and its offset
 * on 4598 or the chart's own 4599, so the income statement still shows the cost
 * once. The import turns a source code or an account label into a momskod, and
 * on a cost account that stands beside such a pair that momskod reports each
 * of those purchases a second time.
 *
 * Only where the pair itself reports ruta 20-24, though. The same shape also
 * carries what the declaration reports elsewhere or not at all: an import's
 * tullvärde on 4545 (ruta 50), a group account such as 4500 that no box
 * reads. Whether a leg reports depends on the momskod it gets in Accounted,
 * which only the mapping set knows, so the evidence keeps each set of legs
 * apart and rcBasisPairFinding judges them once that is known.
 *
 * Only the vouchers say which way the source reported, and that can change
 * within a year, in either direction: pairs taking over from the account's own
 * basis, or the other way round. A momskod is account-wide, so the evidence
 * keeps both how often the account stands beside a pair and when the latest
 * voucher of each kind is dated: the periods still to be declared from
 * Accounted are the latest ones.
 */

/**
 * The offset leg of a basis pair: BAS 4598, or a chart's own 4599. The family
 * rc-basis-reconcile and learned line patterns accept; no basis account ends
 * in 9x.
 */
const OFFSET_ACCOUNT = /^4[45]9\d$/

/**
 * BAS groups 44 and 45, purchases with reverse charge in Sweden and from
 * abroad, where a chart keeps any basis accounts of its own (a 4505 paired with
 * 4599). Such a leg is a candidate only: it counts where its momskod reports
 * ruta 20-24 (rcBasisPairFinding).
 */
const RC_PURCHASE_GROUP = /^4[45]\d\d$/

/** Utgående moms on a reverse-charge purchase, rutor 30-32. */
const RC_OUTPUT_VAT_ACCOUNTS: ReadonlySet<string> = new Set(['2614', '2624', '2634'])

/**
 * An account whose momskod could report a reverse-charge basis: class 4-6,
 * other than the BAS basis accounts, which report theirs by number, and the
 * offsets.
 */
function isCostAccount(account: string): boolean {
  return /^[456]\d{3}$/.test(account) && !isReverseChargeBasisAccount(account) && !OFFSET_ACCOUNT.test(account)
}

/** Each account's net amount in the voucher, in öre, debit positive. */
function netInOre(voucher: SIEVoucher): Map<string, number> {
  const net = new Map<string, number>()
  for (const line of voucher.lines) {
    net.set(line.account, (net.get(line.account) ?? 0) + Math.round(line.amount * 100))
  }
  return net
}

/**
 * The basis legs of a voucher's pair: the accounts opposite the offset that
 * balance it to the öre, looked for among the BAS basis accounts first and in
 * the whole 44xx/45xx range only when those do not. Null when nothing balances
 * it, which is also what a cost line that cannot be told from a leg gives: the
 * voucher is then no evidence either way.
 */
function basisLegs(net: ReadonlyMap<string, number>, offset: number): string[] | null {
  const balancing = (isLeg: (account: string) => boolean) => {
    const legs = [...net].filter(([account, ore]) =>
      Math.sign(ore) === -Math.sign(offset) && !OFFSET_ACCOUNT.test(account) && isLeg(account))
    const total = legs.reduce((sum, [, ore]) => sum + ore, 0)
    return total + offset === 0 ? legs.map(([account]) => account) : null
  }
  return balancing(isReverseChargeBasisAccount)
    ?? balancing((account) => isReverseChargeBasisAccount(account) || RC_PURCHASE_GROUP.test(account))
}

/**
 * The cost accounts the vouchers book beside a separate basis pair, keyed by
 * account (RcBasisPairEvidence). A cost account stands beside the pair when it
 * sits on the basis legs' side of a voucher whose offset those legs balance.
 * It carries its own basis when its voucher books utgående moms on a
 * reverse-charge purchase on the other side and neither an offset nor a BAS
 * basis account beside it.
 */
export function rcBasisPairsByAccount(vouchers: readonly SIEVoucher[]): Map<string, RcBasisPairEvidence> {
  const beside = new Map<string, Map<string, RcBasisPairShape>>()
  const ownBasisLastAt = new Map<string, number>()
  for (const voucher of vouchers) {
    const net = netInOre(voucher)
    // A voucher rebuilt from JSON carries its date as a string.
    const time = new Date(voucher.date).getTime()
    let offset = 0
    let rcOutput = 0
    const offsetAccounts: string[] = []
    for (const [account, ore] of net) {
      if (OFFSET_ACCOUNT.test(account) && ore !== 0) {
        offset += ore
        offsetAccounts.push(account)
      } else if (RC_OUTPUT_VAT_ACCOUNTS.has(account)) {
        rcOutput += ore
      }
    }

    if (offset === 0) {
      if (rcOutput === 0) continue
      const purchaseSide = -Math.sign(rcOutput)
      // A BAS basis account beside the cost reports the basis by number.
      if ([...net].some(([account, ore]) => isReverseChargeBasisAccount(account) && Math.sign(ore) === purchaseSide)) continue
      for (const [account, ore] of net) {
        if (!isCostAccount(account) || Math.sign(ore) !== purchaseSide) continue
        ownBasisLastAt.set(account, Math.max(time, ownBasisLastAt.get(account) ?? time))
      }
      continue
    }

    const legs = basisLegs(net, offset)
    if (!legs) continue
    const shape = { legs: [...legs].sort(), offsets: offsetAccounts.sort() }
    const key = `${shape.legs.join(',')}/${shape.offsets.join(',')}`
    // The purchase is self-assessed in this voucher: output VAT on the offset's side.
    const selfAssessed = rcOutput !== 0 && Math.sign(rcOutput) === Math.sign(offset)
    for (const [account, ore] of net) {
      if (!isCostAccount(account) || legs.includes(account) || Math.sign(ore) !== -Math.sign(offset)) continue
      const shapes = beside.get(account) ?? new Map<string, RcBasisPairShape>()
      const seen = shapes.get(key) ?? { ...shape, vouchers: 0, lastAt: time }
      shapes.set(key, {
        ...seen,
        vouchers: seen.vouchers + 1,
        lastAt: Math.max(seen.lastAt, time),
        ...(selfAssessed ? { lastSelfAssessedAt: Math.max(seen.lastSelfAssessedAt ?? time, time) } : {}),
      })
      beside.set(account, shapes)
    }
  }

  const evidence = new Map<string, RcBasisPairEvidence>()
  for (const [account, shapes] of beside) {
    const ownBasis = ownBasisLastAt.get(account)
    evidence.set(account, {
      pairs: [...shapes.values()],
      ...(ownBasis === undefined ? {} : { ownBasisLastAt: ownBasis }),
    })
  }
  return evidence
}

/** What an account's evidence amounts to, counting only pairs that report ruta 20-24. */
export interface RcBasisPairFinding {
  /** The legs and offsets of those pairs, ascending (['4535', '4599']). */
  accounts: string[]
  /** How many vouchers book the account beside such a pair. */
  vouchers: number
  /**
   * Whether the latest of them is at least as recent as the latest voucher
   * whose basis only the account itself can report: the way the file ends up
   * reporting, which the periods still to be declared follow.
   */
  latest: boolean
}

/**
 * The evidence once it is known which legs report ruta 20-24 in Accounted
 * (`legReports`), or null when no pair beside the account does. A pair counts
 * only when every leg reports: then the pair carries the whole basis and a
 * reverse-charge momskod on the account would carry it again. Where a leg
 * reports elsewhere (4545, ruta 50) or nowhere (4500), the pair is no
 * evidence, and a self-assessed purchase beside it is one more whose basis
 * only the account's momskod reports, like a purchase with no pair at all.
 */
export function rcBasisPairFinding(
  evidence: RcBasisPairEvidence | undefined,
  legReports: (account: string) => boolean,
): RcBasisPairFinding | null {
  if (!evidence) return null
  const reporting = evidence.pairs.filter((pair) => pair.legs.every(legReports))
  if (reporting.length === 0) return null
  const lastAt = Math.max(...reporting.map((pair) => pair.lastAt))
  const ownBasisLastAt = Math.max(
    evidence.ownBasisLastAt ?? -Infinity,
    ...evidence.pairs.filter((pair) => !reporting.includes(pair)).map((pair) => pair.lastSelfAssessedAt ?? -Infinity),
  )
  return {
    accounts: [...new Set(reporting.flatMap((pair) => [...pair.legs, ...pair.offsets]))].sort(),
    vouchers: reporting.reduce((sum, pair) => sum + pair.vouchers, 0),
    latest: lastAt >= ownBasisLastAt,
  }
}
