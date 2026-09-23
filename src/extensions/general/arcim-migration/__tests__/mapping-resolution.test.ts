/**
 * Issue #2212: the guided import's mapping step offered no target for a
 * Fortnox account that exists in neither the company chart nor BAS (4599),
 * and the user could not tell whether the import handled it.
 *
 * These tests run the exact resolution /sie-data runs (buildMappingTargets
 * then suggestMappings) and pin the contract the mapping step now renders:
 *   - an in-range source account the chart lacks resolves to ITSELF and is
 *     created on import with the class and type the importer derives from
 *     the number (classifyAccount: the same helper syncMappedAccounts uses);
 *   - that holds with or without a #KONTO name;
 *   - a number outside 1000-8999 stays unresolved and blocks the step.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { buildMappingTargets } from '../lib/mapping-targets'
import { suggestMappings, validateMappings, isValidBASRange } from '@/lib/import/account-mapper'
import { classifyAccount } from '@/lib/bookkeeping/account-classifier'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/** A company whose chart holds only the given rows (one page, then empty). */
function supabaseWithChart(rows: Array<Record<string, unknown>>): SupabaseClient {
  let served = false
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    range: () => Promise.resolve({ data: served ? [] : ((served = true), rows), error: null }),
  }
  return { from: () => builder } as unknown as SupabaseClient
}

describe('guided import: resolving a source account the target chart lacks', () => {
  it('4599 is in neither BAS nor an empty chart, so no dropdown target exists for it', async () => {
    expect(getBASReference('4599')).toBeUndefined()
    const targets = await buildMappingTargets(supabaseWithChart([]), 'company-1')
    expect(targets.find((t) => t.account_number === '4599')).toBeUndefined()
  })

  // The user's case: a #KONTO row with a name and no postings in any exported
  // year. It resolves to itself; the import creates it under the file's name.
  it('self-maps a named #KONTO-only account onto its own number', async () => {
    const targets = await buildMappingTargets(supabaseWithChart([]), 'company-1')
    const [mapping] = suggestMappings([{ number: '4599', name: 'Justering inköp' }], targets)

    expect(mapping.targetAccount).toBe('4599')
    expect(mapping.targetName).toBe('Justering inköp')
    expect(mapping.matchType).toBe('bas_range')
    expect(validateMappings([mapping]).valid).toBe(true)
  })

  // The other route to the same screen: an account referenced by #TRANS/#IB
  // without a #KONTO row arrives nameless. It must resolve the same way; the
  // importer names it "Konto 4599" (account-sync fallback, tested there).
  it('self-maps a nameless account referenced only by transactions', async () => {
    const targets = await buildMappingTargets(supabaseWithChart([]), 'company-1')
    const [mapping] = suggestMappings([{ number: '4599', name: '' }], targets)

    expect(mapping.targetAccount).toBe('4599')
    expect(mapping.matchType).toBe('bas_range')
    expect(validateMappings([mapping]).valid).toBe(true)
  })

  // The type the created account gets is derived from the number range by
  // the importer's own classifier, never asked of the user.
  it('derives the created account type from the number range', () => {
    expect(classifyAccount('4599')).toEqual({ account_type: 'expense', normal_balance: 'debit' })
    expect(classifyAccount('1932')).toEqual({ account_type: 'asset', normal_balance: 'debit' })
    expect(classifyAccount('2093')).toEqual({ account_type: 'equity', normal_balance: 'credit' })
  })

  // Nothing can be created for a number outside BAS: the step must block and
  // the user must pick a chart account for its postings.
  it('leaves an out-of-range account unresolved so the step blocks', async () => {
    const targets = await buildMappingTargets(supabaseWithChart([]), 'company-1')
    const [mapping] = suggestMappings([{ number: '9100', name: 'Internt konto' }], targets)

    expect(mapping.targetAccount).toBe('')
    expect(isValidBASRange('9100')).toBe(false)
    expect(validateMappings([mapping])).toMatchObject({ valid: false, unmappedAccounts: ['9100'] })
  })

  // A company that already renamed the account keeps its own row as the
  // target (exact match on the chart), so nothing is created twice.
  it('prefers the company row when the account already exists in the chart', async () => {
    const targets = await buildMappingTargets(
      supabaseWithChart([{ account_number: '4599', account_name: 'Eget namn', account_class: 4 }]),
      'company-1',
    )
    const [mapping] = suggestMappings([{ number: '4599', name: 'Justering inköp' }], targets)

    expect(mapping.targetAccount).toBe('4599')
    expect(mapping.targetName).toBe('Eget namn')
    expect(mapping.matchType).toBe('exact')
  })
})
