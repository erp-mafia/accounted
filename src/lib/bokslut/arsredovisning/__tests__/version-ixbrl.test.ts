/**
 * A locked version freezes the iXBRL input, but two parts of the filed
 * document are only known after the lock: the signatures and the årsstämma.
 * Both must reach the file, the intyg must carry today's date, and the
 * warnings frozen at the lock about them must go once they are in.
 */
import { describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { makeInput } from '@/lib/bokslut/ixbrl/__tests__/fixtures'
import {
  AGM_DATE_MISSING_WARNING,
  AGM_DECISION_MISSING_WARNING,
  NOT_ALL_SIGNED_WARNING,
} from '@/lib/bokslut/ixbrl/input-warnings'

vi.mock('../version-service', () => ({ getAnnualReportVersion: vi.fn() }))

import { getAnnualReportVersion } from '../version-service'
import {
  getVersionIxbrlInput,
  overlayFaststallelseintyg,
  overlayVersionSignatures,
} from '../version-ixbrl'

describe('getVersionIxbrlInput', () => {
  it('renders a signed version with its signatures, the AGM and no stale lock warnings', async () => {
    const frozen = makeInput()
    frozen.warnings = [NOT_ALL_SIGNED_WARNING, AGM_DATE_MISSING_WARNING]
    frozen.faststallelseintyg.arsstammaDatum = null
    vi.mocked(getAnnualReportVersion).mockResolvedValue({
      summary: { id: 'v-1', status: 'signed' },
      ixbrl_data: frozen,
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { signer_name: 'Erik Solkatt', role: 'Styrelseordförande', signed_at: '2026-10-22T22:02:16.001+00:00' },
        { signer_name: 'Sara Solkatt', role: 'Verkställande direktör', signed_at: '2026-10-22T22:02:16.148+00:00' },
      ],
    })
    enqueue({ data: { agm_date: '2026-10-23', agm_disposition_outcome: 'proposal_approved', agm_disposition_decision: null } })

    const input = await getVersionIxbrlInput(supabase as never, 'company-1', 'fp-1', 'v-1')

    expect(input?.underskrifter.signers.map((signer) => signer.signedDate)).toEqual(['2026-10-23', '2026-10-23'])
    expect(input?.underskrifter.dateringsdatum).toBe('2026-10-23')
    expect(input?.faststallelseintyg.arsstammaDatum).toBe('2026-10-23')
    expect(input?.warnings).toEqual([])
  })

  it('keeps the "not signed yet" warning on a version still waiting for signatures', async () => {
    const frozen = makeInput()
    frozen.warnings = [NOT_ALL_SIGNED_WARNING]
    vi.mocked(getAnnualReportVersion).mockResolvedValue({
      summary: { id: 'v-1', status: 'ready_for_signature' },
      ixbrl_data: frozen,
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ signer_name: 'Erik Solkatt', role: 'Styrelseledamot', signed_at: '2026-10-22T10:00:00Z' }] })
    enqueue({ data: null })

    const input = await getVersionIxbrlInput(supabase as never, 'company-1', 'fp-1', 'v-1')

    expect(input?.warnings).toEqual([NOT_ALL_SIGNED_WARNING])
  })
})

describe("the revisor's påteckning on a locked version", () => {
  it('splits the revisor off the board and renders the påteckning frozen on the signed revisor slot', async () => {
    vi.mocked(getAnnualReportVersion).mockResolvedValue({
      summary: { id: 'v-1', status: 'signed' },
      ixbrl_data: makeInput(),
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: '2026-02-20T10:00:00Z', pateckning_opinion: null, pateckning_firm_name: null },
        {
          signer_name: 'Rita Revisor',
          role: 'Huvudansvarig revisor',
          signed_at: '2026-02-24T10:00:00Z',
          pateckning_opinion: 'unmodified',
          pateckning_firm_name: 'Revisionsbyrån AB',
        },
      ],
    })
    enqueue({ data: null }) // no AGM recorded
    // The profile was edited after the påteckning: the version does not follow.
    enqueue({ data: { auditor_report_required: true, auditor_firm_name: 'Annan byrå AB', auditor_opinion: 'avstyrkt_br' } })

    const input = await getVersionIxbrlInput(supabase as never, 'company-1', 'fp-1', 'v-1')

    expect(input?.underskrifter.signers.map((signer) => signer.lastName)).toEqual(['Karlsson'])
    expect(input?.underskrifter.dateringsdatum).toBe('2026-02-20')
    expect(input?.revisorspateckning).toEqual({
      required: true,
      revisionsbolag: 'Revisionsbyrån AB',
      opinion: 'unmodified',
      revisorer: [
        { firstName: 'Rita', lastName: 'Revisor', titel: 'Huvudansvarig revisor', huvudansvarig: true, signedDate: '2026-02-24' },
      ],
    })
  })

  it('reads the profile while the revisor slot is still pending', async () => {
    vi.mocked(getAnnualReportVersion).mockResolvedValue({
      summary: { id: 'v-1', status: 'ready_for_signature' },
      ixbrl_data: makeInput(),
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: '2026-02-20T10:00:00Z' },
        { signer_name: 'Rita Revisor', role: 'Godkänd revisor', signed_at: null },
      ],
    })
    enqueue({ data: null })
    enqueue({ data: { auditor_report_required: true, auditor_firm_name: null, auditor_opinion: 'modified' } })

    const input = await getVersionIxbrlInput(supabase as never, 'company-1', 'fp-1', 'v-1')

    expect(input?.revisorspateckning).toMatchObject({ required: true, revisionsbolag: null, opinion: 'modified' })
  })

  it('takes nothing from the profile for a version without a revisor slot', async () => {
    vi.mocked(getAnnualReportVersion).mockResolvedValue({
      summary: { id: 'v-1', status: 'filed' },
      ixbrl_data: makeInput(),
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: '2026-02-20T10:00:00Z' }] })
    enqueue({ data: null })
    enqueue({ data: { auditor_report_required: false, auditor_firm_name: 'Revisionsbyrån AB', auditor_opinion: 'unmodified' } })

    const input = await getVersionIxbrlInput(supabase as never, 'company-1', 'fp-1', 'v-1')

    expect(input?.revisorspateckning).toBeNull()
  })
})

describe('overlayVersionSignatures', () => {
  it('dates the report by the earliest signature and detects a VD', () => {
    const input = makeInput()
    overlayVersionSignatures(
      input,
      [
        { signer_name: 'Karl Karlsson', role: 'Styrelseordförande', signed_at: '2026-02-21T11:00:00Z' },
        { signer_name: 'Karin Olsson', role: 'VD', signed_at: '2026-02-20T11:00:00Z' },
      ],
      { complete: true },
    )
    expect(input.underskrifter.dateringsdatum).toBe('2026-02-20')
    expect(input.underskrifter.harVd).toBe(true)
    expect(input.underskrifter.signers.map((signer) => signer.signedDate)).toEqual(['2026-02-21', '2026-02-20'])
  })

  it('dates a signature given just after midnight by the Swedish day, not the UTC one', () => {
    const input = makeInput()
    overlayVersionSignatures(
      input,
      [{ signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: '2026-10-22T22:02:16.001+00:00' }],
      { complete: true },
    )
    expect(input.underskrifter.signers[0].signedDate).toBe('2026-10-23')
    expect(input.underskrifter.dateringsdatum).toBe('2026-10-23')
  })

  it('drops the "not signed yet" warning frozen at the lock only once the version is signed', () => {
    const rows = [{ signer_name: 'Karl Karlsson', role: 'Styrelseledamot', signed_at: '2026-02-21T11:00:00Z' }]
    const signed = makeInput()
    signed.warnings = [NOT_ALL_SIGNED_WARNING, 'Annan varning.']
    overlayVersionSignatures(signed, rows, { complete: true })
    expect(signed.warnings).toEqual(['Annan varning.'])

    const partly = makeInput()
    partly.warnings = [NOT_ALL_SIGNED_WARNING]
    overlayVersionSignatures(partly, rows, { complete: false })
    expect(partly.warnings).toEqual([NOT_ALL_SIGNED_WARNING])
  })
})

describe('overlayFaststallelseintyg', () => {
  it('fills in the AGM recorded after the lock, dates the intyg today and clears the AGM warnings', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        agm_date: '2026-04-02',
        agm_disposition_outcome: 'alternative_decision',
        agm_disposition_decision: 'Hela resultatet balanseras i ny räkning.',
      },
    })
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = null
    input.faststallelseintyg.resultatdispositionOutcome = null
    input.warnings = [
      AGM_DATE_MISSING_WARNING,
      AGM_DECISION_MISSING_WARNING,
      'Datum för årsstämma saknas. Fastställelseintyget i PDF:en lämnas tomt på datumraden tills det fylls i nedan.',
      'Annan varning.',
    ]

    await overlayFaststallelseintyg(supabase as never, 'company-1', 'fp-1', input, '2026-04-03')

    expect(input.faststallelseintyg.arsstammaDatum).toBe('2026-04-02')
    expect(input.faststallelseintyg.resultatdispositionOutcome).toBe('alternative_decision')
    expect(input.faststallelseintyg.resultatdispositionDecision).toBe('Hela resultatet balanseras i ny räkning.')
    expect(input.faststallelseintyg.genereratDatum).toBe('2026-04-03')
    expect(input.warnings).toEqual(['Annan varning.'])
  })

  it('keeps what the version froze, and its warnings, when nothing was recorded since', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    const input = makeInput()
    input.faststallelseintyg.arsstammaDatum = null
    input.warnings = [AGM_DATE_MISSING_WARNING]

    await overlayFaststallelseintyg(supabase as never, 'company-1', 'fp-1', input, '2026-04-03')

    expect(input.faststallelseintyg.arsstammaDatum).toBeNull()
    expect(input.faststallelseintyg.resultatdispositionOutcome).toBe('proposal_approved')
    expect(input.faststallelseintyg.genereratDatum).toBe('2026-04-03')
    expect(input.warnings).toEqual([AGM_DATE_MISSING_WARNING])
  })

  it('refuses to build the file when the AGM cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })
    await expect(
      overlayFaststallelseintyg(supabase as never, 'company-1', 'fp-1', makeInput(), '2026-04-03'),
    ).rejects.toThrow('Failed to load the AGM decision')
  })
})
