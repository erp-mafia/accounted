import { describe, expect, it } from 'vitest'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import { DEFAULT_ACCOUNTS_BY_CATEGORY, OWN_DEVELOPMENT_ACCOUNTS } from '../asset-service'

/**
 * crm#1452: an account the register or a K3 voucher names that the company's
 * chart lacks is added the way the engine adds one, which only works for a
 * standard BAS account. Every account the K3 stack writes on its own must
 * therefore be in BAS_REFERENCE.
 */
const K3_ACCOUNTS = [
  // Nedskrivning and its reversal (impairment-accounts.ts), per category.
  '7710', '7760', '7720', '7770', '7731', '7781', '7732', '7782', '7733', '7783',
  '1098', '1118', '1158', '1218', '1228', '1298',
  // Mark (category land).
  '1130', '7820',
  // Uppskjuten skatt (K3 kap. 29): the liability, the asset and the cost.
  '2240', '1370', '8940',
  // Own development under the aktiveringsmodell (K3 18.7) and its fund
  // (ÅRL 4 kap. 2 §).
  ...Object.values(OWN_DEVELOPMENT_ACCOUNTS),
  '2089',
]

describe('accounts the K3 asset paths write', () => {
  it('are standard BAS accounts the chart backfill can add', () => {
    const triples = Object.values(DEFAULT_ACCOUNTS_BY_CATEGORY).flatMap((triple) => [triple.asset, triple.accumulated, triple.expense])
    expect([...K3_ACCOUNTS, ...triples].filter((account) => !isStandardBASAccount(account))).toEqual([])
  })
})
