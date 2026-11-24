/**
 * A learned counterpart of one pair that books reverse charge stores no box:
 * it replays the EU-service default (ruta 21, basis 4535). Ruta 21 is a
 * service from a seller in another EU country, ruta 22 one from a seller
 * outside the EU (Skatteverket, "Fylla i momsdeklarationen", fält 21 and 22),
 * so the default is right only when the seller is in the EU.
 *
 * Seen: a software seller outside the EU booked on 5420 with the ruta 22
 * basis pair (4531/4598) every month, while the learned pair proposed ruta 21
 * and, settled after three bookings, booked it from the row's one click.
 *
 * The pair now books from one click only when its box is confirmed: by the
 * cost account (a BAS basis account, or a momskod that reports ruta 20-24),
 * or by the company's posted bookings of the counterparty, every reverse
 * charge among them in the box the pair books. Anything else asks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CounterpartyTemplateMatch } from '@/lib/bookkeeping/counterparty-templates'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import type { CategorizationTemplate } from '@/types'
import type { PrecedentBooking, PrecedentLine } from '../booking-precedent'

const { counterparts, clearingPropose } = vi.hoisted(() => ({ counterparts: vi.fn(), clearingPropose: vi.fn() }))
vi.mock('@/lib/bookkeeping/counterparty-templates', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/counterparty-templates')>()),
  findCounterpartyTemplatesBatch: counterparts,
}))
vi.mock('@/lib/composition/clearing-proposals', () => ({
  CLEARING_PROPOSERS: [{ id: 'fake', module: 'pos', propose: clearingPropose }],
}))

import { proposeForTransactions } from '../propose'
import { rowProposal } from '../category-suggestions'
import { DIRECT_BOOKING_ON, reviewReason } from '../direct-booking'
import { historyConfirmsBox } from '../reverse-charge-box-evidence'
import { offeredSuggestions } from '@/lib/suggestion-log/classify'
import { whyTextSv } from '@/lib/bookkeeping/proposal'
import { chartVatTreatmentsOf } from '@/lib/bookkeeping/vat-entries'

const COMPANY = 'company-1'
const row = makeTransaction({ id: 'tx-1', amount: -230, merchant_name: 'Cloudvendor', description: 'Cloudvendor', original_description: 'Cloudvendor', document_id: null })

const line = (account: string, debit: number, credit: number): PrecedentLine => ({ account, debit, credit })
let seq = 0
function booking(lines: PrecedentLine[], over: Partial<PrecedentBooking> = {}): PrecedentBooking {
  seq += 1
  return { transaction_id: `earlier-${seq}`, date: '2026-09-11', amount: -230, journal_entry_id: `entry-${seq}`, settlement_ledger: null, lines, ...over }
}
/** A service bought on 5420 with its basis pair in the given box and the fiktiv moms beside it. */
const reverseCharge = (basis: string, cost = '5420') =>
  booking([line(cost, 230, 0), line(basis, 230, 0), line('4598', 0, 230), line('2645', 57.5, 0), line('2614', 0, 57.5), line('1930', 0, 230)])
const outsideEu = () => reverseCharge('4531')
const insideEu = () => reverseCharge('4535')
/** The cost booked on an account that reports its own box: no basis pair. */
const onOwnAccount = (account: string) =>
  booking([line(account, 230, 0), line('2645', 57.5, 0), line('2614', 0, 57.5), line('1930', 0, 230)])
const swedishMoms = () => booking([line('5420', 184, 0), line('2641', 46, 0), line('1930', 0, 230)])

const pair = (over: Partial<CategorizationTemplate> = {}) =>
  makeCategorizationTemplate({
    id: 'tpl-cloud',
    counterparty_name: 'cloudvendor',
    counterparty_aliases: ['cloudvendor'],
    debit_account: '5420',
    credit_account: '1930',
    vat_treatment: 'reverse_charge',
    vat_account: '2645',
    occurrence_count: 8,
    mode: 'propose',
    ...over,
  })
const matchOf = (template: CategorizationTemplate): CounterpartyTemplateMatch => ({ template, matchMethod: 'exact_normalized', confidence: 0.9 })

interface Scene {
  booked?: PrecedentBooking[]
  precedentError?: boolean
  chart?: Array<{ account_number: string; default_vat_treatment: string; default_vat_rate?: number | null }>
}

function ledger(scene: Scene) {
  return createTableMockSupabase({
    mapping_rules: { data: [], error: null },
    company_settings: { data: { entity_type: 'aktiebolag', direct_booking_enabled: true }, error: null },
    transaction_assistant_reads: { data: [], error: null },
    chart_of_accounts: { data: scene.chart ?? [], error: null },
    'rpc:booking_precedents': (chain) => {
      if (scene.precedentError) return { data: null, error: { message: 'timeout' } }
      const asked = (chain[0].args[0] as { p_names: string[] }).p_names
      const names: Record<string, string> = {}
      const bookings: Record<string, PrecedentBooking[]> = {}
      for (const text of asked) {
        names[text] = text.toLowerCase()
        if (scene.booked) bookings[text.toLowerCase()] = scene.booked
      }
      return { data: { names, bookings }, error: null }
    },
  })
}

async function propose(template: CategorizationTemplate, scene: Scene = {}, tx = row) {
  counterparts.mockResolvedValue(new Map([[tx.id, matchOf(template)]]))
  const mock = ledger(scene)
  const out = await proposeForTransactions(mock.supabase as unknown as SupabaseClient, COMPANY, [tx])
  const lead = rowProposal(out.proposals[tx.id] ?? []) as BookingProposal
  return { mock, lead, list: out.proposals[tx.id] ?? [], reason: reviewReason(lead, DIRECT_BOOKING_ON) }
}

const precedentCalls = (mock: ReturnType<typeof ledger>) => mock.findCalls('rpc:booking_precedents', 'rpc').length

beforeEach(() => {
  vi.clearAllMocks()
  clearingPropose.mockResolvedValue(new Map<string, BookingProposal>())
})

describe('a learned reverse-charge pair books from one click only when its box is confirmed', () => {
  it('asks when the company books the counterparty in ruta 22 and the pair books ruta 21', async () => {
    const { lead, reason } = await propose(pair(), { booked: [outsideEu(), outsideEu(), outsideEu()] })
    expect(lead.source).toBe('counterparty')
    expect(lead.reverse_charge_box_unconfirmed).toBe(true)
    expect(reason).toBe('evidence')
  })

  it('says why to an agent, and the log records it', async () => {
    const { lead, list } = await propose(pair(), { booked: [outsideEu()] })
    expect(whyTextSv(lead)).toContain('ruta 21')
    expect(whyTextSv(lead)).toContain('ruta 22')
    expect(offeredSuggestions(list).suggestions[0].evidence).toMatchObject({ reverse_charge_box_unconfirmed: true })
  })

  it('asks when the books mix the two boxes', async () => {
    const { reason } = await propose(pair(), { booked: [insideEu(), outsideEu(), insideEu()] })
    expect(reason).toBe('evidence')
  })

  it('asks when no posted reverse charge of the counterparty is in the books', async () => {
    for (const booked of [[], [swedishMoms()]]) {
      const { lead, reason } = await propose(pair(), { booked })
      expect(lead.reverse_charge_box_unconfirmed).toBe(true)
      expect(reason).toBe('evidence')
    }
  })

  it('asks when the books cannot be read', async () => {
    const { reason } = await propose(pair(), { precedentError: true })
    expect(reason).toBe('evidence')
  })

  it('books from one click as before when every posted reverse charge is in ruta 21', async () => {
    const { lead, reason } = await propose(pair(), { booked: [insideEu(), insideEu(), swedishMoms()] })
    expect(lead.reverse_charge_box_unconfirmed).toBeUndefined()
    expect(reason).toBeNull()
  })

  it('books as before, without reading the books, when the cost account is a basis account', async () => {
    const { mock, lead, reason } = await propose(pair({ debit_account: '4535' }))
    expect(lead.reverse_charge_box_unconfirmed).toBeUndefined()
    expect(reason).toBeNull()
    expect(precedentCalls(mock)).toBe(0)
  })

  it('books as before when the cost account\'s momskod reports the box', async () => {
    const chart = [{ account_number: '5420', default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: 0.25 }]
    const { lead, reason } = await propose(pair(), { chart, booked: [outsideEu()] })
    expect(lead.reverse_charge_box_unconfirmed).toBeUndefined()
    expect(reason).toBeNull()
  })

  it('leaves a pair without reverse charge, and a learned pattern with its basis pair, alone', async () => {
    const plain = await propose(pair({ vat_treatment: 'standard_25', vat_account: '2641' }))
    expect(plain.lead.reverse_charge_box_unconfirmed).toBeUndefined()
    expect(plain.reason).toBeNull()
    expect(precedentCalls(plain.mock)).toBe(0)

    const pattern = await propose(
      pair({
        vat_treatment: null,
        vat_account: null,
        line_pattern: [
          { account: '5420', type: 'business', side: 'debit', ratio: 1 },
          { account: '4531', type: 'business', side: 'debit', ratio: 1 },
          { account: '4598', type: 'business', side: 'credit', ratio: 1 },
        ],
      }),
    )
    expect(pattern.lead.reverse_charge_box_unconfirmed).toBeUndefined()
    expect(precedentCalls(pattern.mock)).toBe(0)
  })
})

describe('historyConfirmsBox', () => {
  const none = chartVatTreatmentsOf([])

  it('confirms only a box every posted reverse charge of the counterparty booked', () => {
    expect(historyConfirmsBox([insideEu(), insideEu()], 'eu_services', none)).toBe(true)
    expect(historyConfirmsBox([outsideEu()], 'non_eu_services', none)).toBe(true)
    expect(historyConfirmsBox([insideEu(), outsideEu()], 'eu_services', none)).toBe(false)
    expect(historyConfirmsBox([outsideEu()], 'eu_services', none)).toBe(false)
  })

  it('reads the box off a cost account that reports it itself, the chart\'s momskod included', () => {
    expect(historyConfirmsBox([onOwnAccount('4531')], 'eu_services', none)).toBe(false)
    expect(historyConfirmsBox([onOwnAccount('4535')], 'eu_services', none)).toBe(true)
    const chart = chartVatTreatmentsOf([{ account_number: '6540', default_vat_treatment: 'reverse_charge_non_eu_services', default_vat_rate: 0.25 }])
    expect(historyConfirmsBox([onOwnAccount('6540')], 'non_eu_services', chart)).toBe(true)
    expect(historyConfirmsBox([onOwnAccount('6540')], 'non_eu_services', none)).toBe(false)
    expect(historyConfirmsBox([onOwnAccount('6540')], 'eu_services', chart)).toBe(false)
  })

  it('confirms the box only at the sats the pair books: an EU service at 12 % is not one at 25 %', () => {
    expect(historyConfirmsBox([reverseCharge('4536')], 'eu_services', none)).toBe(false)
    const twelve = chartVatTreatmentsOf([{ account_number: '6540', default_vat_treatment: 'reverse_charge_eu_services', default_vat_rate: 0.12 }])
    expect(historyConfirmsBox([onOwnAccount('6540')], 'eu_services', twelve)).toBe(false)
  })

  it('confirms nothing without a posted reverse charge, or with one whose box it cannot read', () => {
    expect(historyConfirmsBox([], 'eu_services', none)).toBe(false)
    expect(historyConfirmsBox([swedishMoms()], 'eu_services', none)).toBe(false)
    // Fiktiv moms with no basis anywhere: the box was never declared.
    expect(historyConfirmsBox([onOwnAccount('6540')], 'eu_services', none)).toBe(false)
  })

  it('reads purchases only: a refund says nothing about the box of the next purchase', () => {
    const refund = booking(
      [line('1930', 230, 0), line('4598', 230, 0), line('4531', 0, 230), line('2614', 57.5, 0), line('2645', 0, 57.5), line('5420', 0, 230)],
      { amount: 230 },
    )
    expect(historyConfirmsBox([insideEu(), refund], 'eu_services', none)).toBe(true)
  })
})
