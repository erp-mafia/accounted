import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import type { ReconciliationItem } from './schemas'

/**
 * The Avstämning overview's rows, with each verifikat shown once.
 *
 * A proposal is not a link, so the ledger bucket (get_unlinked_gl_lines on
 * a bank account, the unlinked 1630 entries on the skattekonto) still holds
 * the verifikat a row is proposed against. On the overview that listed it
 * twice: in the proposed pair, where "Koppla" settles it, and again in the
 * ledger-only list, where the only button is "Granska" and the page reads
 * as if the other side never had the payment. This drops the second
 * listing, for a 1:1 proposal and for every verifikat of a covering set.
 *
 * Only when the proposals fully explain the verifikat: the live proposals
 * pointing at it must sum to its net on the account, to the öre. A 1:1 pair
 * shows the bank row's amount on its ledger side, while the ledger row nets
 * every line the verifikat has on the account, so a multi-line verifikat
 * proposed for part of its net keeps its ledger row: that row is the only
 * place the overview shows the gap. A covering-set voucher counts its bank
 * leg (positive, in the row's direction); a verifikat proposed for several
 * rows (a skattekonto group, two bank rows) counts all of them.
 *
 * Display only, on purpose. The unmatched_ledger bucket from the API keeps
 * the verifikat: "Matcha manuellt", MCP and v1 read it to override a
 * proposal. The status counts and the bridge keep counting it as unmatched
 * until the pair is linked, because the external row and the verifikat are
 * both reconciling lines until then.
 */
export function dropProposedLedgerDuplicates(items: ReconciliationItem[]): ReconciliationItem[] {
  const proposedSum = new Map<string, number>()
  const add = (entryId: string, amount: number) =>
    proposedSum.set(entryId, roundOre((proposedSum.get(entryId) ?? 0) + amount))
  for (const item of items) {
    if (item.bucket !== 'proposed' || !item.proposal) continue
    const vouchers = item.proposal.vouchers
    if (vouchers && vouchers.length > 0) {
      const sign = item.amount < 0 ? -1 : 1
      for (const v of vouchers) add(v.journal_entry_id, sign * v.amount)
    } else {
      add(item.proposal.journal_entry_id, item.amount)
    }
  }
  if (proposedSum.size === 0) return items
  return items.filter((item) => {
    if (item.bucket !== 'unmatched_ledger' || item.item_type !== 'journal_entry') return true
    const sum = proposedSum.get(item.item_id)
    return sum === undefined || Math.abs(sum - item.amount) >= ORE_TOLERANCE
  })
}
