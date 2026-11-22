import { describe, expect, it } from 'vitest'
import { proposeBeneficialOwners } from '../beneficial-owners'
import { aktiebokCsv } from '../csv'
import { buildAktiebokPdfData, buildAktiebrevData, buildHolderExtractData, companyCategory, describeEvent } from '../pdf-data'
import { reconcileWithSettings } from '../reconcile'
import { replayShareRegister, summarizeHoldings } from '../register-state'
import type { RolesView } from '../roles'
import type { ShareRegisterData } from '../share-register'
import { namesRepresentatives, roleFromPosition, rolesFromTicSnapshot, signatoryRulesFromTicSnapshot } from '../tic-seed'
import type { RegisterParty, ShareClass, ShareEvent } from '../types'
import { bolagetRollout, isBolagetEnabled } from '@/lib/env/bolaget-switch'

const A: ShareClass = {
  id: 'class-a', code: 'A', name: 'Stamaktier', votes_per_share: 1,
  forbehall_samtycke: false, forbehall_forkop: true, forbehall_hembud: false, forbehall_omvandling: false, forbehall_inlosen: false,
  forbehall_text: 'Förköpsförbehåll enligt § 9', bolagsordning_reference: '§ 9',
}

function ev(partial: Partial<ShareEvent> & Pick<ShareEvent, 'id' | 'event_number' | 'kind' | 'event_date'>): ShareEvent {
  return {
    share_class_id: null, to_share_class_id: null, from_party_id: null, to_party_id: null, range_start: null, range_end: null,
    transfer_reason: null, price_total: null, ratio: null, aktiebrev_number: null, aktiebrev_action: null, counterparty_party_id: null,
    note_status: null, corrects_event_id: null, registered_on: null, decision_id: null, document_id: null, journal_entry_id: null,
    note: null, created_at: '2026-02-01T10:00:00Z', ...partial,
  }
}

const parties = new Map<string, RegisterParty>([
  ['anna', { party_id: 'anna', name: 'Anna Ek', kind: 'person', org_number: null, personnummer_masked: 'XXXXXXXX-1234', foreign_id_masked: null, birth_date: null, address: { line1: 'Storgatan 1', line2: null, postal_code: '111 22', city: 'Stockholm', country: 'SE' }, email: null }],
  ['bo', { party_id: 'bo', name: 'Bo Holding AB', kind: 'company', org_number: '5560000001', personnummer_masked: null, foreign_id_masked: null, birth_date: null, address: null, email: null }],
  ['cia', { party_id: 'cia', name: 'Cia Ek', kind: 'person', org_number: null, personnummer_masked: null, foreign_id_masked: null, birth_date: null, address: null, email: null }],
])

const events: ShareEvent[] = [
  ev({ id: 'e1', event_number: 1, kind: 'bildande', event_date: '2020-01-10', to_party_id: 'anna', share_class_id: 'class-a', range_start: 1, range_end: 500, price_total: 25000 }),
  ev({ id: 'e2', event_number: 2, kind: 'bildande', event_date: '2020-01-10', to_party_id: 'bo', share_class_id: 'class-a', range_start: 501, range_end: 750 }),
  ev({ id: 'e3', event_number: 3, kind: 'bildande', event_date: '2020-01-10', to_party_id: 'cia', share_class_id: 'class-a', range_start: 751, range_end: 1000 }),
  ev({ id: 'e4', event_number: 4, kind: 'aktiebrev', event_date: '2020-02-01', range_start: 1, range_end: 500, aktiebrev_number: '1', aktiebrev_action: 'issued' }),
  ev({ id: 'e5', event_number: 5, kind: 'overlatelse', event_date: '2021-01-01', from_party_id: 'cia', to_party_id: 'anna', share_class_id: 'class-a', range_start: 991, range_end: 1000, transfer_reason: 'gava' }),
  ev({ id: 'e6', event_number: 6, kind: 'rattelse', event_date: '2021-02-01', corrects_event_id: 'e5', note: 'Fel datum' }),
]

function registerData(asOf = '2026-10-29'): ShareRegisterData {
  const replay = replayShareRegister(events, asOf)
  return {
    as_of: asOf,
    is_avstamningsbolag: false,
    setup_completed_at: null,
    classes: [A],
    events,
    replay,
    summary: summarizeHoldings(replay.ranges, [A]),
    parties,
    reconciliation: reconcileWithSettings(replay.totalShares, { aktiekapital: 25000, antal_aktier: 1000 }),
    note_problems: replay.noteProblems,
  }
}

const roles: RolesView = {
  as_of: '2026-10-29',
  signatory_rule: 'Firman tecknas av styrelsen',
  roles: [
    { id: 'r1', party_id: 'anna', role: 'styrelseordforande', valid_from: '2020-01-10', valid_to: null, source: 'registry_tic', decision_id: null, registered_at: null, details: {}, created_at: '', party: parties.get('anna')!, label_sv: 'Styrelseordförande', active: true },
    { id: 'r2', party_id: 'cia', role: 'styrelsesuppleant', valid_from: '2020-01-10', valid_to: null, source: 'registry_tic', decision_id: null, registered_at: null, details: {}, created_at: '', party: parties.get('cia')!, label_sv: 'Styrelsesuppleant', active: true },
  ],
  signatory_rules: [],
  board: [],
  ceo: null,
}

describe('tic seed', () => {
  it('maps registry positions to roles, the specific before the general', () => {
    expect(roleFromPosition('ceo', 'Verkställande direktör')).toBe('vd')
    expect(roleFromPosition(null, 'Vice verkställande direktör')).toBe('vice_vd')
    expect(roleFromPosition('boardMember', 'Styrelseledamot')).toBe('styrelseledamot')
    expect(roleFromPosition(null, 'Styrelseordförande')).toBe('styrelseordforande')
    expect(roleFromPosition(null, 'Styrelsesuppleant')).toBe('styrelsesuppleant')
    expect(roleFromPosition(null, 'Huvudansvarig revisor')).toBe('huvudansvarig_revisor')
    expect(roleFromPosition(null, 'Revisorssuppleant')).toBe('revisorssuppleant')
    expect(roleFromPosition(null, 'Revisor')).toBe('revisor')
    expect(roleFromPosition(null, 'Extern firmatecknare')).toBe('sarskild_firmatecknare')
    expect(roleFromPosition(null, 'Lekmannarevisor')).toBeNull()
    expect(roleFromPosition('unknownThing', null)).toBeNull()
  })

  it('reads representatives defensively, one row per person and role', () => {
    const roles = rolesFromTicSnapshot({
      representatives: [
        { name: 'Anna Ek', positionType: 'ceo', positionDescription: 'Verkställande direktör', positionStart: '2020-01-10T00:00:00' },
        { name: 'Anna Ek', positionType: 'ceo', positionDescription: 'Verkställande direktör', positionStart: '2020-01-10T00:00:00' },
        { name: 'Revisionsbyrån AB', positionDescription: 'Revisor', positionStart: null },
        { name: null, positionDescription: 'Styrelseledamot' },
        'garbage',
      ],
    })
    expect(roles).toEqual([
      { name: 'Anna Ek', kind: 'person', role: 'vd', valid_from: '2020-01-10', valid_to: null, position: 'Verkställande direktör' },
      { name: 'Revisionsbyrån AB', kind: 'company', role: 'revisor', valid_from: null, valid_to: null, position: 'Revisor' },
    ])
    expect(rolesFromTicSnapshot(null)).toEqual([])
    expect(rolesFromTicSnapshot({ representatives: 'x' })).toEqual([])
  })

  it('takes only a list that names someone as an answer about the board', () => {
    expect(namesRepresentatives({ representatives: [{ name: 'Anna Ek' }] })).toBe(true)
    for (const snapshot of [null, 'x', {}, { representatives: [] }, { representatives: 'x' }, { representatives: [], incompleteSections: ['representatives'] }]) {
      expect(namesRepresentatives(snapshot)).toBe(false)
    }
  })

  it('splits run-on firmateckning clauses and drops the list markers', () => {
    expect(
      signatoryRulesFromTicSnapshot({
        signatory: [
          { description: '> Firman tecknas av styrelsen > Firman tecknas av två ledamöter i förening' },
          { description: 'Firman tecknas av styrelsen' },
          {},
        ],
      }),
    ).toEqual(['Firman tecknas av styrelsen', 'Firman tecknas av två ledamöter i förening'])
  })
})

describe('proposeBeneficialOwners', () => {
  it('proposes persons with more than 25 % of the votes and lists companies for investigation', () => {
    const data = registerData()
    const p = proposeBeneficialOwners(data.summary, parties, data.as_of)
    expect(p.owners.map((o) => [o.name, o.votes_pct])).toEqual([['Anna Ek', 50]])
    expect(p.owners[0]!.extent).toBe('50 % av rösterna och 50 % av kapitalet genom eget ägande.')
    // Exactly 25 % is not more than 25 %.
    expect(p.indirect).toEqual([])
    expect(p.conclusion).toBe('owners_identified')
  })

  it('concludes no beneficial owner when nobody holds more than a quarter', () => {
    const replay = replayShareRegister([
      ev({ id: 'x1', event_number: 1, kind: 'bildande', event_date: '2020-01-01', to_party_id: 'anna', share_class_id: 'class-a', range_start: 1, range_end: 25 }),
      ev({ id: 'x2', event_number: 2, kind: 'bildande', event_date: '2020-01-01', to_party_id: 'bo', share_class_id: 'class-a', range_start: 26, range_end: 100 }),
    ])
    const p = proposeBeneficialOwners(summarizeHoldings(replay.ranges, [A]), parties, '2026-01-01')
    expect(p.owners).toEqual([])
    expect(p.indirect.map((o) => o.name)).toEqual(['Bo Holding AB'])
    expect(p.conclusion).toBe('no_beneficial_owner')
  })
})

describe('pdf data', () => {
  it('prints shares in numerical order with identity, address, aktiebrev and the 8:45 flag', () => {
    const data = buildAktiebokPdfData(registerData(), roles, { name: 'Testbolaget AB', org_number: '5561234567' }, { generatedAt: '2026-10-29' })
    expect(data.total_shares).toBe(1000)
    expect(data.rows.map((r) => [r.range_start, r.range_end, r.holder_name, r.aktiebrev, r.board_flag])).toEqual([
      [1, 500, 'Anna Ek', 'Nr 1 (2020-02-01)', true],
      [501, 750, 'Bo Holding AB', null, false],
      [751, 1000, 'Cia Ek', null, true],
    ])
    expect(data.rows[0]!.identity).toBe('XXXXXXXX-1234')
    expect(data.rows[0]!.address).toBe('Storgatan 1, 111 22 Stockholm')
    expect(data.rows[1]!.identity).toBe('556000-0001')
    expect(data.classes[0]!.forbehall).toEqual(['Förköpsförbehåll (4 kap. 18 § ABL)'])
    expect(data.officer_holdings).toEqual([
      { name: 'Anna Ek', roles: 'Styrelseordförande', shares: 500 },
      { name: 'Cia Ek', roles: 'Styrelsesuppleant', shares: 250 },
    ])
    expect(data.history.find((h) => h.event_number === 5)).toMatchObject({ voided: true })
    expect(data.history.find((h) => h.event_number === 6)!.text).toBe('Rättelse av anteckning nr 5. Fel datum')
    expect(data.full_identity).toBe(false)
  })

  it('prints the full personnummer when given', () => {
    const data = buildAktiebokPdfData(registerData(), roles, { name: 'T AB', org_number: null }, {
      generatedAt: '2026-10-29',
      fullPersonnummer: new Map([['anna', '19800101-1234']]),
    })
    expect(data.rows[0]!.identity).toBe('19800101-1234')
    expect(data.full_identity).toBe(true)
  })

  it('describes a transfer with its reason and price', () => {
    const text = describeEvent(
      ev({ id: 't', event_number: 9, kind: 'overlatelse', event_date: '2022-01-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: 'class-a', range_start: 1, range_end: 10, transfer_reason: 'kop', price_total: 1500 }),
      parties,
      [A],
      new Map(),
    )
    expect(text).toBe('Överlåtelse (köp): aktie 1-10 (10 st, serie A) från Anna Ek till Cia Ek, 1 500,00 kr')
  })

  it('builds a holder extract with only the entries that name them', () => {
    const extract = buildHolderExtractData(registerData(), 'bo', { name: 'T AB', org_number: null }, { generatedAt: '2026-10-29' })!
    expect(extract.shares).toBe(250)
    expect(extract.capital_pct).toBe(25)
    expect(extract.rows.map((r) => [r.range_start, r.range_end])).toEqual([[501, 750]])
    expect(extract.history.map((h) => h.event_number)).toEqual([2])
    expect(buildHolderExtractData(registerData(), 'nobody', { name: 'T AB', org_number: null }, { generatedAt: 'x' })).toBeNull()
  })

  it('builds an aktiebrev for one holder with the board as signers', () => {
    const data = registerData()
    const brev = buildAktiebrevData(events[3]!, data, replayShareRegister(events, '2020-02-01'), roles, { name: 'T AB', org_number: '5561234567' })!
    expect(brev).toMatchObject({ number: '1', issued_on: '2020-02-01', count: 500, class_code: 'A', holder: { name: 'Anna Ek' } })
    expect(brev.forbehall).toEqual(['Förköpsförbehåll (4 kap. 18 § ABL)'])
    expect(brev.signers).toEqual([{ name: 'Anna Ek', role: 'Styrelseordförande' }])
    expect(buildAktiebrevData(events[0]!, data, data.replay, roles, { name: 'T AB', org_number: null })).toBeNull()
    // ABL 6:2 p. 1: the certificate states the bolagskategori.
    expect(brev.company_category).toBe('Privat aktiebolag')
  })

  it('reads the bolagskategori from the name: a public company carries (publ) or says it is public', () => {
    expect(companyCategory('T AB')).toBe('Privat aktiebolag')
    expect(companyCategory('Republik Media AB')).toBe('Privat aktiebolag')
    expect(companyCategory('Stora Bolaget AB (publ)')).toBe('Publikt aktiebolag')
    expect(companyCategory('Stora Publikt Aktiebolag')).toBe('Publikt aktiebolag')
  })

  it('describes a holding carried over from an earlier register', () => {
    const text = describeEvent(
      ev({ id: 'o', event_number: 1, kind: 'ingaende', event_date: '2026-01-01', to_party_id: 'anna', share_class_id: 'class-a', range_start: 1, range_end: 500, note: 'Tidigare aktiebok i pärm hos styrelsen' }),
      parties,
      [A],
      new Map(),
    )
    expect(text).toBe('Ingående innehav: aktie 1-500 (500 st, serie A) hos Anna Ek, överfört från bolagets tidigare aktiebok. Tidigare aktiebok i pärm hos styrelsen')
  })

  it('states the day of the event in an entry that carries the day it was made', () => {
    const text = describeEvent(
      ev({ id: 't2', event_number: 10, kind: 'overlatelse', event_date: '2026-11-22', occurred_on: '2026-10-01', from_party_id: 'anna', to_party_id: 'cia', share_class_id: 'class-a', range_start: 1, range_end: 10, transfer_reason: 'gava' }),
      parties,
      [A],
      new Map(),
    )
    expect(text).toBe('Överlåtelse (gåva): aktie 1-10 (10 st, serie A) från Anna Ek till Cia Ek. Händelsens dag 2026-10-01')
    // A free-text note says it too.
    const note = describeEvent(ev({ id: 'n', event_number: 11, kind: 'anteckning', event_date: '2026-11-22', occurred_on: '2026-10-01', note: 'Hembud avslutat.' }), parties, [A], new Map())
    expect(note).toBe('Anteckning: Hembud avslutat. Händelsens dag 2026-10-01')
    expect(describeEvent(ev({ id: 'n2', event_number: 12, kind: 'anteckning', event_date: '2026-11-22', note: 'Hembud avslutat.' }), parties, [A], new Map())).toBe('Anteckning: Hembud avslutat.')
  })
})

describe('csv', () => {
  it('writes semicolon rows with a BOM in three views', () => {
    const data = buildAktiebokPdfData(registerData(), roles, { name: 'T AB', org_number: null }, { generatedAt: '2026-10-29' })
    const shares = aktiebokCsv(data, 'shares')
    expect(shares.startsWith('﻿Aktienummer från;')).toBe(true)
    expect(shares).toContain('1;500;500;A;Anna Ek;XXXXXXXX-1234;Storgatan 1, 111 22 Stockholm;Nr 1 (2020-02-01);;Ja')
    expect(aktiebokCsv(data, 'holders')).toContain('Anna Ek;XXXXXXXX-1234;500;500;50;50;Ja')
    expect(aktiebokCsv(data, 'history').split('\r\n')[0]).toBe('﻿Nr;Datum;Införd;Typ;Anteckning;Rättad')
  })
})

describe('reconcileWithSettings', () => {
  it('compares the register with antal_aktier', () => {
    expect(reconcileWithSettings(1000, { aktiekapital: 25000, antal_aktier: 1000 })).toEqual({ status: 'match', register_shares: 1000, settings_shares: 1000, aktiekapital: 25000, kvotvarde: 25 })
    expect(reconcileWithSettings(900, { aktiekapital: 25000, antal_aktier: 1000 }).status).toBe('mismatch')
    expect(reconcileWithSettings(900, { aktiekapital: null, antal_aktier: null }).status).toBe('settings_empty')
    expect(reconcileWithSettings(0, { aktiekapital: 25000, antal_aktier: 1000 }).status).toBe('register_empty')
    expect(reconcileWithSettings(0, { aktiekapital: null, antal_aktier: null }).status).toBe('both_empty')
  })
})

describe('bolaget switch', () => {
  it('opens for listed ids or everyone, nobody when unset', () => {
    expect(bolagetRollout({})).toEqual([])
    expect(isBolagetEnabled('abc', {})).toBe(false)
    expect(isBolagetEnabled('abc', { BOLAGET_COMPANY_IDS: '*' })).toBe(true)
    expect(isBolagetEnabled('ABC', { BOLAGET_COMPANY_IDS: 'x, abc ,abc' })).toBe(true)
    expect(bolagetRollout({ BOLAGET_COMPANY_IDS: 'x, abc ,abc' })).toEqual(['x', 'abc'])
    expect(isBolagetEnabled(null, { BOLAGET_COMPANY_IDS: '*' })).toBe(false)
  })
})
