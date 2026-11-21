/**
 * gnubok_formation (formation-tools.ts): the chat door to a company
 * formation. The store, the register lookup and the setup are mocked; the
 * rules (lib/formation/rules) and the answer merge run for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { emptyAnswers, type FormationAnswers } from '@/lib/formation/answers'
import { sealAnswers, type FormationRow } from '@/lib/formation/store'

const mocks = vi.hoisted(() => ({
  current: null as unknown,
  saved: [] as Array<{ id: string | null; answers: unknown }>,
  submitted: [] as string[],
  lookup: null as unknown,
  setupCalls: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/formation/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/formation/store')>()
  const row = (answers: unknown, extra: Record<string, unknown> = {}) => ({
    ...(mocks.current as Record<string, unknown> | null ?? {}),
    id: 'f-1',
    user_id: 'user-1',
    status: 'draft',
    answers,
    deed_date: null,
    company_id: null,
    setup_state: {},
    created_at: '2026-11-20T09:00:00Z',
    ...extra,
  })
  return {
    ...actual,
    currentFormation: vi.fn(async () => mocks.current),
    createFormation: vi.fn(async (_s: unknown, _u: string, answers: FormationAnswers) => {
      mocks.saved.push({ id: null, answers })
      return row(actual.sealAnswers(answers, null))
    }),
    saveAnswers: vi.fn(async (_s: unknown, _u: string, id: string, answers: FormationAnswers) => {
      mocks.saved.push({ id, answers })
      const prior = actual.parseStoredAnswers((mocks.current as { answers: unknown }).answers)
      return row(actual.sealAnswers(answers, prior))
    }),
    markSubmitted: vi.fn(async (_s: unknown, _u: string, _id: string, deedDate: string) => {
      mocks.submitted.push(deedDate)
      return row((mocks.current as { answers: unknown }).answers, { status: 'submitted', deed_date: deedDate })
    }),
  }
})

vi.mock('@/extensions/general/tic/lib/lookup', () => ({
  lookupCompanyByOrgNumber: vi.fn(async () => mocks.lookup),
}))

vi.mock('@/lib/formation/setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/formation/setup')>()
  return {
    ...actual,
    runFormationSetup: vi.fn(async (args: Record<string, unknown>) => {
      mocks.setupCalls.push(args)
      return { companyId: 'company-new', state: {} }
    }),
  }
})

import { createFormationTools, fillIssueText, mergeChatAnswers } from '../formation-tools'
import sv from '@/messages/sv.json'

// Published Skatteverket test personnummer; a valid test org number.
const PNR_A = '195001182046'
const PNR_B = '201212121212'
const ORG = '5595386219'

function interview(): Record<string, unknown> {
  return {
    names: ['Testbolaget Nord AB', 'Nordtest AB'],
    description: 'konsultverksamhet inom systemutveckling och drift av webbtjänster',
    seat: 'Stockholm',
    address: { co: '', street: 'Testgatan 1', postalCode: '11122', city: 'Stockholm' },
    contact: { name: 'Test Testsson', email: 'test@example.se', phone: '+46701234567' },
    bank: 'svea',
    parties: [
      { id: 'p1', type: 'person', name: 'Test Testsson', shares: 500, roles: ['ledamot', 'vd'] },
      { id: 'p2', type: 'person', name: 'Deputy Person', shares: 0, roles: ['suppleant'] },
    ],
  }
}

/** The interview with both personnummer typed on the page, sealed. */
function completeStored(): FormationAnswers {
  const a = { ...emptyAnswers(), ...(interview() as Partial<FormationAnswers>) } as FormationAnswers
  return sealAnswers(
    {
      ...a,
      parties: [
        { id: 'p1', type: 'person', name: 'Test Testsson', personnummer: PNR_A, email: '', shares: 500, roles: ['ledamot', 'vd'] },
        { id: 'p2', type: 'person', name: 'Deputy Person', personnummer: PNR_B, email: '', shares: 0, roles: ['suppleant'] },
      ],
    },
    null,
  )
}

function currentRow(answers: unknown, extra: Partial<FormationRow> = {}) {
  return { id: 'f-1', user_id: 'user-1', status: 'draft', answers, deed_date: null, company_id: null, setup_state: {}, created_at: '2026-11-20T09:00:00Z', ...extra }
}

const supabase = { rpc: vi.fn(async () => ({ data: 'company-new', error: null })) } as unknown as SupabaseClient
const deps = {
  annotations: { effect: 'additive' as const, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  appOrigin: () => 'https://app.example.se',
  defaultTeamForUser: vi.fn(async () => 'team-1'),
  newCompanyReach: vi.fn(async () => 'default' as const),
}
const [tool] = createFormationTools(deps)
const run = (args: Record<string, unknown>) => tool.execute(args, null as never, 'user-1', supabase, { type: 'mcp_oauth', id: 'key-1' }) as Promise<Record<string, unknown>>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.current = null
  mocks.saved = []
  mocks.submitted = []
  mocks.lookup = null
  mocks.setupCalls = []
})

describe('mergeChatAnswers', () => {
  it('drops a personnummer the chat sent', () => {
    const raw = interview()
    ;(raw.parties as Array<Record<string, unknown>>)[0].personnummer = PNR_A
    const { answers, droppedPersonnummer } = mergeChatAnswers(raw, null)
    expect(droppedPersonnummer).toBe(true)
    expect(answers.parties.every((p) => p.type !== 'person' || p.personnummer === '')).toBe(true)
  })

  it('keeps the id of a person already stored, matched by name, so the sealed number survives', () => {
    const stored = completeStored()
    const raw = interview()
    ;(raw.parties as Array<Record<string, unknown>>)[0].id = 'renamed-by-the-chat'
    const { answers } = mergeChatAnswers(raw, stored)
    expect(answers.parties[0].id).toBe('p1')
    // The store seals by id: the prior sealed number carries over.
    const sealed = sealAnswers(answers, stored)
    expect(sealed.parties[0]).toMatchObject({ personnummerLast4: '2046' })
  })

  it('keeps stored sections the chat did not send', () => {
    const stored = completeStored()
    const { answers } = mergeChatAnswers({ seat: 'Göteborg' }, stored)
    expect(answers.seat).toBe('Göteborg')
    expect(answers.names).toEqual(stored.names)
    expect(answers.parties).toEqual(stored.parties)
  })

  it('refuses answers of the wrong shape', () => {
    expect(() => mergeChatAnswers({ capital: { amount: 'lots' } }, null)).toThrow(/answers/)
  })
})

describe('fillIssueText', () => {
  it('fills names and Swedish numbers', () => {
    expect(fillIssueText('{subscribed, number} av {total, number} aktier, {name}', { subscribed: 1000, total: 25000, name: 'Anna' })).toBe(`${new Intl.NumberFormat('sv-SE').format(1000)} av ${new Intl.NumberFormat('sv-SE').format(25000)} aktier, Anna`)
  })

  it('covers every formation.issues text: only {key} and {key, number} placeholders', () => {
    for (const [code, text] of Object.entries(sv.formation.issues as Record<string, string>)) {
      const placeholders = text.match(/\{[^}]*\}/g) ?? []
      for (const p of placeholders) expect(p, `formation.issues.${code}`).toMatch(/^\{\w+(, number)?\}$/)
    }
  })
})

describe('gnubok_formation', () => {
  it('is company-independent and stays under the description limit', () => {
    expect(tool.name).toBe('gnubok_formation')
    expect(tool.description.length).toBeLessThanOrEqual(280)
    expect(tool.inputSchema.additionalProperties).toBe(false)
  })

  it('status without a formation says to interview first', async () => {
    const out = await run({ action: 'status' })
    expect(out.formation).toBeNull()
    expect(String(out.next)).toMatch(/start-company/)
  })

  it('save starts a formation and sends the founder to the page for personnummer', async () => {
    const out = await run({ action: 'save', answers: interview() })
    expect(mocks.saved).toHaveLength(1)
    expect(out.ready).toBe(false)
    expect(out.personnummer_needed_for).toEqual(['Test Testsson', 'Deputy Person'])
    expect(out.page_url).toBe('https://app.example.se/starta-bolag')
    // The only blocking issues are the personnummer, which the chat never handles.
    expect((out.issues as Array<{ severity: string }>).filter((i) => i.severity === 'error')).toEqual([])
    expect(String(out.next)).toMatch(/page_url/)
    expect(String(out.next)).toMatch(/Never ask for a personnummer/)
  })

  it("save names a broken rule in the interview's own Swedish words", async () => {
    const raw = interview()
    raw.parties = [{ id: 'p1', type: 'person', name: 'Solo Founder', shares: 500, roles: ['ledamot'] }]
    const out = await run({ action: 'save', answers: raw })
    const deputy = (out.issues as Array<{ code: string; message_sv: string }>).find((i) => i.code === 'deputy_required')
    expect(deputy?.message_sv).toBe('Med färre än tre ledamöter behövs minst en suppleant.')
    expect(String(out.next)).toMatch(/issues/)
  })

  it('save updates the open formation instead of starting a second', async () => {
    mocks.current = currentRow(completeStored())
    const out = await run({ action: 'save', answers: { seat: 'Göteborg' } })
    expect(mocks.saved[0].id).toBe('f-1')
    expect(out.ready).toBe(true)
    expect(out.documents).toContain('aktiebok')
  })

  it('save reports a personnummer it did not keep', async () => {
    const raw = interview()
    ;(raw.parties as Array<Record<string, unknown>>)[0].personnummer = PNR_A
    const out = await run({ action: 'save', answers: raw })
    expect(out.personnummer_note).toBeTruthy()
  })

  it('submitted refuses a deed date in the future', async () => {
    mocks.current = currentRow(completeStored())
    await expect(run({ action: 'submitted', deed_date: '2999-01-01' })).rejects.toThrow()
    expect(mocks.submitted).toEqual([])
  })

  it('submitted records the day every founder signed', async () => {
    mocks.current = currentRow(completeStored())
    const out = await run({ action: 'submitted', deed_date: '2026-11-19' })
    expect(mocks.submitted).toEqual(['2026-11-19'])
    expect(String(out.next)).toMatch(/action=setup/)
  })

  it('setup without a formation refuses', async () => {
    await expect(run({ action: 'setup', org_number: ORG })).rejects.toThrow()
  })

  it('setup asks for the registreringsbevis when the register has nothing yet', async () => {
    mocks.current = currentRow(completeStored(), { status: 'submitted', deed_date: '2026-11-19' })
    const out = await run({ action: 'setup', org_number: ORG })
    expect(out.registry).toBe('not_found')
    expect(String(out.next)).toMatch(/registreringsbevis/)
    expect(mocks.setupCalls).toEqual([])
  })

  it("setup previews from the founder's registreringsbevis and writes nothing", async () => {
    mocks.current = currentRow(completeStored(), { status: 'submitted', deed_date: '2026-11-19' })
    const out = await run({ action: 'setup', org_number: ORG, company_name: 'Testbolaget Nord AB', registration_date: '2026-11-20' })
    expect(out.requires_confirmation).toBe(true)
    const preview = out.preview as Record<string, unknown>
    expect(preview.first_fiscal_year).toEqual({ start: '2026-11-20', end: '2026-12-31' })
    expect(preview.aktiebok).toEqual([{ name: 'Test Testsson', shares: 500, share_numbers: '1-500' }])
    expect(mocks.setupCalls).toEqual([])
  })

  it('setup refuses to confirm before the founder confirms the beneficial owners', async () => {
    mocks.current = currentRow(completeStored(), { status: 'submitted', deed_date: '2026-11-19' })
    await expect(
      run({ action: 'setup', org_number: ORG, company_name: 'Testbolaget Nord AB', registration_date: '2026-11-20', confirm: true }),
    ).rejects.toThrow(/beneficial_owners_confirmed/)
    expect(mocks.setupCalls).toEqual([])
  })

  it('setup sets the company up through the service-role company path', async () => {
    mocks.current = currentRow(completeStored(), { status: 'submitted', deed_date: '2026-11-19' })
    mocks.lookup = { companyName: 'Testbolaget Nord AB', legalEntityType: 'Aktiebolag', isCeased: false, registrationDate: Date.parse('2026-11-20T00:00:00Z'), registration: {} }
    const out = await run({ action: 'setup', org_number: ORG, beneficial_owners_confirmed: true, confirm: true })
    expect(out.created).toBe(true)
    expect(out.company_id).toBe('company-new')
    expect(mocks.setupCalls).toHaveLength(1)
    const call = mocks.setupCalls[0] as { input: Record<string, unknown>; insertCompany: (name: string) => Promise<unknown> }
    expect(call.input).toMatchObject({ orgNumber: ORG, companyName: 'Testbolaget Nord AB', registrationDate: '2026-11-20', beneficialOwnersConfirmed: true })
    await call.insertCompany('Testbolaget Nord AB')
    expect(supabase.rpc).toHaveBeenCalledWith('create_company_for_user', { p_user_id: 'user-1', p_name: 'Testbolaget Nord AB', p_entity_type: 'aktiebolag', p_team_id: 'team-1' })
    expect(String(out.next)).toMatch(/uses the new company/)
  })

  it('setup refuses an org number that is not an aktiebolag', async () => {
    mocks.current = currentRow(completeStored(), { status: 'submitted', deed_date: '2026-11-19' })
    mocks.lookup = { companyName: 'Någon Firma', legalEntityType: 'Enskild näringsidkare', isCeased: false, registrationDate: Date.parse('2026-11-20T00:00:00Z'), registration: {} }
    await expect(run({ action: 'setup', org_number: ORG, beneficial_owners_confirmed: true, confirm: true })).rejects.toThrow()
    expect(mocks.setupCalls).toEqual([])
  })

  it('setup on a formation already set up answers its company', async () => {
    mocks.current = currentRow(completeStored(), { status: 'set_up', company_id: 'company-old' })
    const out = await run({ action: 'setup', org_number: ORG })
    expect(out.company_id).toBe('company-old')
  })
})
