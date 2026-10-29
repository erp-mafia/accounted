/**
 * The commitments services every door calls (lib/commitments): the rollout
 * gate, the references a write names, manual against derived agreements,
 * what a create writes (the agreement, its expected payments, its dates),
 * the legal-form gate of the group structure and the team check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { createAgreement, endAgreement, listAgreements, updateAgreement, type AgreementRow } from '../agreements'
import { createSecurity, listSecurities } from '../securities'
import { createGroupLink } from '../group-links'

const COMPANY = 'company-1'
const TODAY = '2026-10-29'

const manualRow: AgreementRow = {
  id: 'agr-1',
  company_id: COMPANY,
  kind: 'rental',
  origin: 'manual',
  title: 'Hyresavtal kontor',
  status: 'active',
  counterparty_party_id: null,
  counterparty_name: 'Fastighets AB Kvarnen',
  starts_on: '2026-01-01',
  ends_on: '2028-12-31',
  notice_months: 9,
  renewal_terms: null,
  amount: '12500.00',
  currency: 'SEK',
  period: 'monthly',
  first_due_on: null,
  principal: null,
  interest_rate: null,
  document_id: null,
  source_document_id: null,
  notes: null,
}

function ctxWith(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  return { mock, ctx: { supabase: mock.supabase as unknown as SupabaseClient, companyId: COMPANY, userId: 'user-1' } }
}

beforeEach(() => {
  vi.stubEnv('BOLAGET_COMPANY_IDS', COMPANY)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the rollout gate', () => {
  it('refuses every read and write outside BOLAGET_COMPANY_IDS without reading anything', async () => {
    vi.stubEnv('BOLAGET_COMPANY_IDS', 'someone-else')
    const { mock, ctx } = ctxWith({})
    expect(await listAgreements(ctx)).toEqual({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    expect(await createAgreement(ctx, { kind: 'rental', title: 'X' }, { dryRun: true })).toEqual({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    expect(await listSecurities(ctx)).toEqual({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    expect(await createGroupLink(ctx, { relation: 'parent', counterparty_name: 'X' }, { dryRun: true })).toEqual({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    expect(mock.tables()).toEqual([])
  })
})

describe('createAgreement', () => {
  const input = {
    kind: 'rental' as const,
    title: 'Hyresavtal kontor',
    counterparty_name: 'Fastighets AB Kvarnen',
    starts_on: '2026-01-01',
    ends_on: '2028-12-31',
    notice_months: 9,
    amount: 12500,
    period: 'monthly' as const,
  }

  it('previews the agreement, its expected payments and its dates on a dry run, writing nothing', async () => {
    const { mock, ctx } = ctxWith({})
    const outcome = await createAgreement(ctx, input, { dryRun: true, today: TODAY })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    const preview = (outcome as unknown as { preview: { expected_payments: unknown[]; dates: Array<{ key: string }> } }).preview
    expect(preview.expected_payments).toHaveLength(14)
    expect(preview.dates.map((d) => d.key)).toEqual(['notice', 'end'])
    expect(mock.tables()).toEqual([])
  })

  it('writes a manual row with who registered it, then its payments and its dates in Viktiga datum', async () => {
    const { mock, ctx } = ctxWith({
      agreements: { data: manualRow },
      agreement_obligations: { data: [] },
      deadlines: { data: [] },
    })
    const outcome = await createAgreement(ctx, input, { dryRun: false, today: TODAY })
    expect(outcome).toMatchObject({ ok: true, created: true, data: { agreement_id: 'agr-1', origin: 'manual', amount: 12500 } })
    expect(mock.payloads('agreements', 'insert')[0]).toMatchObject({
      company_id: COMPANY,
      origin: 'manual',
      status: 'active',
      created_by: 'user-1',
      source_document_id: null,
      amount: 12500,
      period: 'monthly',
    })
    const obligations = mock.payloads('agreement_obligations', 'insert')[0] as Array<{ due_on: string; direction: string }>
    expect(obligations).toHaveLength(14)
    expect(obligations.every((o) => o.direction === 'out')).toBe(true)
    const deadlines = mock.payloads('deadlines', 'insert') as Array<{ source_key: string; source_document_id: string | null }>
    expect(deadlines.map((d) => d.source_key)).toEqual(['agreement:agr-1:notice', 'agreement:agr-1:end'])
    expect(deadlines.every((d) => d.source_document_id === null)).toBe(true)
  })

  it('refuses a counterparty that is not the company\'s', async () => {
    const { ctx } = ctxWith({ parties: { data: null } })
    const outcome = await createAgreement(ctx, { ...input, counterparty_party_id: '11111111-1111-4111-8111-111111111111' }, { dryRun: false })
    expect(outcome).toEqual({ ok: false, code: 'COMMITMENTS_REFERENCE_NOT_FOUND', details: { field: 'counterparty_party_id' } })
  })

  it('refuses a document that is not the company\'s', async () => {
    const { ctx } = ctxWith({ document_attachments: { data: null } })
    const outcome = await createAgreement(ctx, { ...input, document_id: '11111111-1111-4111-8111-111111111111' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'COMMITMENTS_REFERENCE_NOT_FOUND', details: { field: 'document_id' } })
  })
})

describe('updateAgreement and endAgreement', () => {
  it('answers AGREEMENT_NOT_FOUND for an id the company does not have', async () => {
    const { ctx } = ctxWith({ agreements: { data: null } })
    expect(await updateAgreement(ctx, 'nope', { amount: 1 }, { dryRun: false })).toEqual({ ok: false, code: 'AGREEMENT_NOT_FOUND' })
    expect(await endAgreement(ctx, 'nope', {}, { dryRun: false })).toEqual({ ok: false, code: 'AGREEMENT_NOT_FOUND' })
  })

  it('leaves an agreement the archive read from a document to the archive', async () => {
    const { mock, ctx } = ctxWith({ agreements: { data: { ...manualRow, origin: 'derived', source_document_id: 'doc-1' } } })
    expect(await updateAgreement(ctx, 'agr-1', { amount: 1 }, { dryRun: false })).toEqual({
      ok: false,
      code: 'AGREEMENT_DERIVED',
      details: { source_document_id: 'doc-1' },
    })
    expect(mock.payloads('agreements', 'update')).toEqual([])
  })

  it('refuses an amount without a period once merged with the stored row', async () => {
    const { ctx } = ctxWith({ agreements: { data: manualRow } })
    expect(await updateAgreement(ctx, 'agr-1', { period: null }, { dryRun: false })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })

  it('writes only the changed columns, rounded to the öre', async () => {
    const { mock, ctx } = ctxWith({ agreements: { data: manualRow }, agreement_obligations: { data: [] }, deadlines: { data: [] } })
    const outcome = await updateAgreement(ctx, 'agr-1', { amount: 13000.005 }, { dryRun: false, today: TODAY })
    expect(outcome.ok).toBe(true)
    expect(mock.payloads('agreements', 'update')[0]).toEqual({ amount: 13000.01 })
  })

  it('ends on the day given, keeping an earlier end date, and drops the dates from Viktiga datum', async () => {
    const { mock, ctx } = ctxWith({
      agreements: [{ data: { ...manualRow, ends_on: '2026-09-30' } }, { data: { ...manualRow, status: 'ended', ends_on: '2026-09-30' } }],
      agreement_obligations: { data: [] },
      deadlines: { data: [{ id: 'dl-1', source_key: 'agreement:agr-1:end', title: 'x', due_date: '2026-09-30', is_completed: false, dismissed_at: null, status: 'upcoming' }] },
    })
    const outcome = await endAgreement(ctx, 'agr-1', { ended_on: '2026-10-31' }, { dryRun: false, today: TODAY })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'ended' } })
    expect(mock.payloads('agreements', 'update')[0]).toEqual({ status: 'ended', ends_on: '2026-09-30' })
    expect(mock.findCalls('deadlines', 'delete')).toHaveLength(1)
  })
})

describe('securities', () => {
  it('lists the rows with the note texts on the balance date', async () => {
    const { ctx } = ctxWith({
      securities_and_contingencies: {
        data: [
          { id: 's-1', company_id: COMPANY, kind: 'borgen', description: 'Borgen för dotterbolaget', amount: '300000.00', in_favour_of_party_id: null, in_favour_of_name: 'Banken', for_group_company: true, agreement_id: null, valid_from: '2025-01-01', valid_to: null, document_id: null, notes: null },
        ],
      },
    })
    const outcome = await listSecurities(ctx, { balance_date: '2026-12-31' })
    expect(outcome.ok).toBe(true)
    const data = (outcome as { data: { securities: Array<{ security_id: string; pledged: boolean; amount: number }>; note_texts: { contingent_liabilities: string | null } } }).data
    expect(data.securities[0]).toMatchObject({ security_id: 's-1', pledged: false, amount: 300000 })
    expect(data.note_texts.contingent_liabilities).toMatch(/^Borgensförbindelser 300\s000 kr\. Varav till förmån för koncernföretag 300\s000 kr\.$/)
  })

  it('refuses a loan agreement that is not the company\'s', async () => {
    const { ctx } = ctxWith({ agreements: { data: null } })
    const outcome = await createSecurity(
      ctx,
      { kind: 'foretagsinteckning', description: 'FI', amount: 500000, agreement_id: '11111111-1111-4111-8111-111111111111' },
      { dryRun: false },
    )
    expect(outcome).toEqual({ ok: false, code: 'COMMITMENTS_REFERENCE_NOT_FOUND', details: { field: 'agreement_id' } })
  })

  it('writes the row with who registered it', async () => {
    const row = { id: 's-2', company_id: COMPANY, kind: 'foretagsinteckning', description: 'FI', amount: '500000.00', in_favour_of_party_id: null, in_favour_of_name: null, for_group_company: false, agreement_id: null, valid_from: null, valid_to: null, document_id: null, notes: null }
    const { mock, ctx } = ctxWith({ securities_and_contingencies: { data: row } })
    const outcome = await createSecurity(ctx, { kind: 'foretagsinteckning', description: 'FI', amount: 500000 }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, created: true, data: { security_id: 's-2', pledged: true } })
    expect(mock.payloads('securities_and_contingencies', 'insert')[0]).toMatchObject({ company_id: COMPANY, user_id: 'user-1', kind: 'foretagsinteckning', amount: 500000 })
  })
})

describe('group links', () => {
  it('are only for a legal form that prepares an årsredovisning', async () => {
    const { mock, ctx } = ctxWith({ companies: { data: { entity_type: 'enskild_firma' } } })
    expect(await createGroupLink(ctx, { relation: 'parent', counterparty_name: 'Ägarbolaget AB' }, { dryRun: false })).toEqual({
      ok: false,
      code: 'GROUP_LINKS_NOT_FOR_LEGAL_FORM',
    })
    expect(mock.payloads('company_group_links', 'insert')).toEqual([])
  })

  it('link another company only when it is in the same team', async () => {
    const other = '22222222-2222-4222-8222-222222222222'
    const { ctx } = ctxWith({
      companies: (calls) =>
        calls.some((c) => c.method === 'in')
          ? { data: [{ id: COMPANY, team_id: 'team-a' }, { id: other, team_id: 'team-b' }] }
          : { data: { entity_type: 'aktiebolag' } },
    })
    expect(await createGroupLink(ctx, { relation: 'subsidiary', counterparty_name: 'Dotter AB', linked_company_id: other }, { dryRun: true })).toEqual({
      ok: false,
      code: 'GROUP_LINK_COMPANY_NOT_IN_TEAM',
    })
  })

  it('writes a parent link for an aktiebolag', async () => {
    const row = { id: 'g-1', company_id: COMPANY, relation: 'parent', counterparty_name: 'Ägarbolaget AB', counterparty_org_number: '559000-0000', counterparty_registered_office: 'Stockholm', party_id: null, ownership_percent: '100.0000', voting_percent: null, valid_from: null, valid_to: null, bas_account: null, linked_company_id: null, notes: null }
    const { mock, ctx } = ctxWith({ companies: { data: { entity_type: 'aktiebolag' } }, company_group_links: { data: row } })
    const outcome = await createGroupLink(
      ctx,
      { relation: 'parent', counterparty_name: 'Ägarbolaget AB', counterparty_org_number: '559000-0000', counterparty_registered_office: 'Stockholm', ownership_percent: 100 },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true, created: true, data: { group_link_id: 'g-1', ownership_percent: 100 } })
    expect(mock.payloads('company_group_links', 'insert')[0]).toMatchObject({ company_id: COMPANY, user_id: 'user-1', relation: 'parent' })
  })
})
