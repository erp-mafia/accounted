import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => supabase }))

import { identityText, maskForeignId, matchRegisterPerson, personNameWords, renameRegisterParty } from '../people'
import type { OperationContext } from '@/lib/operations/types'
import type { RegisterParty } from '../types'

function party(partial: Partial<RegisterParty>): RegisterParty {
  return {
    party_id: 'p1',
    name: 'Namn',
    kind: 'person',
    org_number: null,
    personnummer_masked: null,
    foreign_id_masked: null,
    birth_date: null,
    address: null,
    email: null,
    ...partial,
  }
}

describe('maskForeignId', () => {
  it('shows the last four characters of a foreign identity number, and one of a short one', () => {
    expect(maskForeignId('DE123456789')).toBe('XXXXXXX6789')
    expect(maskForeignId(' AB12 ')).toBe('XXX2')
  })
})

describe('identityText (ABL 5:5 p. 2)', () => {
  it('prints a company by its organisationsnummer', () => {
    expect(identityText(party({ kind: 'company', org_number: '5560000001' }))).toBe('556000-0001')
  })

  it('prints a person by personnummer: full for an owner or admin, else masked', () => {
    const anna = party({ personnummer_masked: 'XXXXXXXX-1234' })
    expect(identityText(anna)).toBe('XXXXXXXX-1234')
    expect(identityText(anna, new Map([['p1', '19800101-1234']]))).toBe('19800101-1234')
  })

  it('prints the other identity number of a holder with neither a personnummer nor an organisationsnummer', () => {
    const hans = party({ foreign_id_masked: 'XXXXXXX6789', birth_date: '1970-05-05' })
    expect(identityText(hans)).toBe('XXXXXXX6789')
    expect(identityText(hans, new Map([['p1', 'DE123456789']]))).toBe('DE123456789')
    expect(identityText(party({ kind: 'company', foreign_id_masked: 'XXXXX4321' }), new Map([['p1', 'HRB 54321']]))).toBe('HRB 54321')
  })

  it('falls back to a birth date only when no number is on file', () => {
    expect(identityText(party({ birth_date: '1970-05-05' }))).toBe('1970-05-05')
    expect(identityText(party({ kind: 'company' }))).toBe('')
  })
})

describe('matchRegisterPerson', () => {
  const board = [
    { id: 'karl', display_name: 'Lindqvist, Karl Erik' },
    { id: 'olof', display_name: 'Berg Holm, Nils Olof' },
    { id: 'maja', display_name: 'Sjöberg, Maja Linnea' },
  ]

  it('reads a name as its words, whatever the order and the commas', () => {
    expect(personNameWords('Lindqvist, Karl Erik')).toEqual(['erik', 'karl', 'lindqvist'])
  })

  it('finds the board member the registry wrote surname first', () => {
    expect(matchRegisterPerson(board, 'Karl Erik Lindqvist')?.id).toBe('karl')
    expect(matchRegisterPerson(board, 'lindqvist, karl erik')?.id).toBe('karl')
  })

  it('finds the person by the given name in use, when at least two words agree', () => {
    expect(matchRegisterPerson(board, 'Karl Lindqvist')?.id).toBe('karl')
    expect(matchRegisterPerson(board, 'Olof Berg Holm')?.id).toBe('olof')
  })

  it('never matches on one word, and never picks between two people a name could mean', () => {
    expect(matchRegisterPerson(board, 'Karl')).toBeNull()
    expect(matchRegisterPerson(board, 'Bo Ek')).toBeNull()
    const family = [...board, { id: 'son', display_name: 'Lindqvist, Karl Johan' }]
    expect(matchRegisterPerson(family, 'Karl Lindqvist')).toBeNull()
  })

  it('prefers the same name over a name that only shares words', () => {
    const two = [{ id: 'short', display_name: 'Anna Ek' }, { id: 'long', display_name: 'Ek, Anna Maria' }]
    expect(matchRegisterPerson(two, 'anna ek')?.id).toBe('short')
  })

  it('counts a word that stands twice as two words', () => {
    expect(personNameWords('Anna Anna')).toEqual(['anna', 'anna'])
    // One typed word never names "Anna Anna".
    expect(matchRegisterPerson([{ id: 'twice', display_name: 'Anna Anna' }], 'Anna')).toBeNull()
    // A reordered name still finds its one person beside a namesake with a repeated word.
    const two = [{ id: 'plain', display_name: 'Ek, Anna' }, { id: 'twice', display_name: 'Ek, Anna Anna' }]
    expect(matchRegisterPerson(two, 'Anna Ek')?.id).toBe('plain')
    expect(matchRegisterPerson(two, 'Anna Anna Ek')?.id).toBe('twice')
  })
})

describe('renameRegisterParty', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const ctx = { supabase, companyId: 'company-1', userId: 'user-1', log } as unknown as OperationContext
  const holder = { id: 'p1', display_name: '5560000001', kind: 'company', org_number: '5560000001' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('renames a party of the company, as the signed-in person', async () => {
    enqueue({ data: [holder] }) // parties in company
    enqueue({ data: null }) // update
    expect(await renameRegisterParty(ctx, 'p1', { name: ' Ek Holding AB ' })).toEqual({ ok: true, party_id: 'p1', name: 'Ek Holding AB', org_number: '5560000001', changed: true })
    expect(findCall('parties', 'update')?.[0]).toEqual({ display_name: 'Ek Holding AB' })
  })

  it('writes nothing when nothing changes', async () => {
    enqueue({ data: [holder] })
    expect(await renameRegisterParty(ctx, 'p1', { name: '5560000001', org_number: '556000-0001' })).toMatchObject({ ok: true, changed: false })
    expect(findCall('parties', 'update')).toBeUndefined()
  })

  it('refuses an empty name, an invalid organisationsnummer and a party of another company', async () => {
    enqueue({ data: [holder] })
    expect(await renameRegisterParty(ctx, 'p1', { name: '  ' })).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_INVALID' })
    enqueue({ data: [holder] })
    expect(await renameRegisterParty(ctx, 'p1', { org_number: '1234' })).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_INVALID' })
    enqueue({ data: [] })
    expect(await renameRegisterParty(ctx, 'p1', { name: 'X' })).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_NOT_FOUND' })
    expect(findCall('parties', 'update')).toBeUndefined()
  })

  it('never takes a personnummer as a person\'s organisationsnummer', async () => {
    enqueue({ data: [{ id: 'p2', display_name: 'Anna Ek', kind: 'person', org_number: null }] })
    expect(await renameRegisterParty(ctx, 'p2', { org_number: '19800101-1234' })).toMatchObject({ ok: false, code: 'BOLAGET_PERSONNUMMER_IN_APP_ONLY' })
  })

  it('says that the organisationsnummer is on another party, before anything is written', async () => {
    enqueue({ data: [{ ...holder, org_number: null }] }) // parties in company
    enqueue({ data: { id: 'other' } }) // the party that has the number
    const outcome = await renameRegisterParty(ctx, 'p1', { org_number: '556000-0001' })
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_INVALID' })
    if (!outcome.ok) expect(outcome.messageSv).toMatch(/finns redan/)
    expect(findCall('parties', 'update')).toBeUndefined()
  })

  it('says the same when another party takes the number between the check and the write', async () => {
    enqueue({ data: [{ ...holder, org_number: null }] })
    enqueue({ data: null }) // nobody has the number yet
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "parties_company_org_number_live"' } })
    const outcome = await renameRegisterParty(ctx, 'p1', { org_number: '556000-0001' })
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_INVALID' })
    if (!outcome.ok) expect(outcome.messageSv).toMatch(/finns redan/)
  })

  it('checks everything and writes nothing on a dry run', async () => {
    enqueue({ data: [holder] })
    expect(await renameRegisterParty(ctx, 'p1', { name: 'Ek Holding AB' }, { dryRun: true })).toMatchObject({ ok: true, name: 'Ek Holding AB', changed: true })
    expect(findCall('parties', 'update')).toBeUndefined()
    enqueue({ data: [holder] })
    expect(await renameRegisterParty(ctx, 'p1', { name: ' ' }, { dryRun: true })).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_INVALID' })
  })
})
