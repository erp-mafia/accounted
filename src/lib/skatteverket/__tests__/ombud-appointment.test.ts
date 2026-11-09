/**
 * The appointment state every surface shows. Skatteverket can take from
 * minutes to over an hour to list a fresh grant (prod, 2026-11-08: 3, 18 and
 * 52 minutes, and one only the next nightly sync found). Until it does, the
 * register has nothing for the company and the row says 'denied': that is a
 * wait, never red. Red is a grant that was there and is gone.
 */
import { describe, it, expect } from 'vitest'
import { ombudAppointment, ombudCheckOutcome, type OmbudConnectionFacts } from '../ombud-appointment'

/** The register's 404 "Ingen funnen" right after signing, as prod recorded it. */
const NOT_LISTED_YET = {
  status: 'denied',
  detail:
    'OMBUD_GRANT_MISSING (ombudsregister otillgängligt: OBR_HTTP_ERROR: Ombudshantering svarade 404 (ombud/autentisieratOmbud): {"felkod": 3, "felmeddelande": "Ingen funnen"})',
}

function row(overrides: Partial<OmbudConnectionFacts> = {}): OmbudConnectionFacts {
  return {
    status: 'pending',
    lasombud_status: 'denied',
    moms_ombud_status: 'denied',
    last_probe_detail: { lasombud: NOT_LISTED_YET, moms_ombud: NOT_LISTED_YET },
    ...overrides,
  }
}

describe('ombudAppointment', () => {
  it('no row: not appointed', () => {
    expect(ombudAppointment(null)).toEqual({ state: 'none', predatesOptIn: false })
  })

  it("the company's own Koppla från: not appointed, whatever was stored before", () => {
    expect(ombudAppointment(row({ status: 'revoked', lasombud_status: 'unknown', moms_ombud_status: 'unknown' }))).toEqual({
      state: 'none',
      predatesOptIn: false,
    })
  })

  it('signed, and the register does not list it yet: waiting, not missing (the case of 2026-11-08)', () => {
    expect(ombudAppointment(row())).toEqual({ state: 'waiting', predatesOptIn: false })
  })

  it('a deep link minted and nothing checked yet: waiting', () => {
    expect(
      ombudAppointment(row({ lasombud_status: 'unknown', moms_ombud_status: 'unknown', last_probe_detail: { lasombud: null, moms_ombud: null } })),
    ).toEqual({ state: 'waiting', predatesOptIn: false })
  })

  it('a check that could not ask Skatteverket while nothing is granted: still waiting', () => {
    expect(
      ombudAppointment(row({ status: 'error', lasombud_status: 'error', last_probe_detail: { lasombud: { status: 'error', detail: 'timeout' } } })),
    ).toEqual({ state: 'waiting', predatesOptIn: false })
  })

  it('both granted: appointed', () => {
    expect(ombudAppointment(row({ status: 'verified', lasombud_status: 'granted', moms_ombud_status: 'granted' }))).toEqual({
      state: 'appointed',
      roles: { lasombud: 'granted', moms_ombud: 'granted' },
      predatesOptIn: false,
    })
  })

  it('one granted, the other never: appointed, the other not included rather than missing', () => {
    expect(
      ombudAppointment(
        row({
          status: 'partial',
          lasombud_status: 'granted',
          last_probe_detail: {
            lasombud: { status: 'granted', detail: 'ombudsregister: lasombud aktiv 2026-11-07' },
            moms_ombud: { status: 'denied', detail: 'ombudsregister: moms_ombud saknas (roller: skol)' },
          },
        }),
      ),
    ).toEqual({ state: 'appointed', roles: { lasombud: 'granted', moms_ombud: 'not_included' }, predatesOptIn: false })
  })

  it('a grant Skatteverket withdrew: withdrawn, the one red state', () => {
    const withdrawn = { status: 'denied', detail: 'ombudsregister 2026-11-09: huvudman saknas', reason: 'withdrawn' }
    expect(ombudAppointment(row({ last_probe_detail: { lasombud: withdrawn, moms_ombud: withdrawn } }))).toEqual({
      state: 'withdrawn',
      roles: { lasombud: 'withdrawn', moms_ombud: 'withdrawn' },
      predatesOptIn: false,
    })
  })

  it('withdrawn stays withdrawn through a check that could not reach Skatteverket', () => {
    expect(
      ombudAppointment(
        row({
          status: 'error',
          lasombud_status: 'error',
          last_probe_detail: { lasombud: { status: 'error', detail: 'timeout', reason: 'withdrawn' }, moms_ombud: NOT_LISTED_YET },
        }),
      ),
    ).toEqual({ state: 'withdrawn', roles: { lasombud: 'withdrawn', moms_ombud: 'not_included' }, predatesOptIn: false })
  })

  it('one still granted and one withdrawn: appointed, the withdrawn one red', () => {
    expect(
      ombudAppointment(
        row({
          status: 'partial',
          lasombud_status: 'granted',
          last_probe_detail: { lasombud: { status: 'granted' }, moms_ombud: { status: 'denied', reason: 'withdrawn' } },
        }),
      ),
    ).toEqual({ state: 'appointed', roles: { lasombud: 'granted', moms_ombud: 'withdrawn' }, predatesOptIn: false })
  })

  it('only a grant signed before the opt-in: not appointed, with the reason, never waiting', () => {
    const predates = { status: 'denied', detail: 'ombudsregister: lasombud signerad 2026-06-01, före kopplingen 2026-07-01', reason: 'predates_opt_in' }
    expect(ombudAppointment(row({ last_probe_detail: { lasombud: predates, moms_ombud: NOT_LISTED_YET } }))).toEqual({
      state: 'none',
      predatesOptIn: true,
    })
  })

  it('a grant that counts beside one signed before the opt-in: appointed, with the reason', () => {
    expect(
      ombudAppointment(
        row({
          status: 'partial',
          lasombud_status: 'granted',
          last_probe_detail: { lasombud: { status: 'granted' }, moms_ombud: { status: 'denied', reason: 'predates_opt_in' } },
        }),
      ),
    ).toEqual({ state: 'appointed', roles: { lasombud: 'granted', moms_ombud: 'not_included' }, predatesOptIn: true })
  })
})

/**
 * What the toast after a check says. It must agree with the card: a check
 * that finds a withdrawn grant, or one signed before the opt-in, is not a
 * wait, except right after signing, when the new signature is simply not
 * listed yet.
 */
describe('ombudCheckOutcome', () => {
  const withdrawn = row({ last_probe_detail: { lasombud: { status: 'denied', reason: 'withdrawn' }, moms_ombud: { status: 'denied', reason: 'withdrawn' } } })
  const predates = row({ last_probe_detail: { lasombud: { status: 'denied', reason: 'predates_opt_in' }, moms_ombud: NOT_LISTED_YET } })

  it('läsombud granted: granted, from either door', () => {
    const granted = row({ status: 'partial', lasombud_status: 'granted' })
    expect(ombudCheckOutcome(granted, { justSigned: true })).toBe('granted')
    expect(ombudCheckOutcome(granted, { justSigned: false })).toBe('granted')
  })

  it('nothing listed yet: waiting, from either door', () => {
    expect(ombudCheckOutcome(row(), { justSigned: true })).toBe('waiting')
    expect(ombudCheckOutcome(row(), { justSigned: false })).toBe('waiting')
    expect(ombudCheckOutcome(null, { justSigned: false })).toBe('waiting')
  })

  it('Kontrollera nu on a withdrawn grant says withdrawn, as the card does', () => {
    expect(ombudCheckOutcome(withdrawn, { justSigned: false })).toBe('withdrawn')
  })

  it('Kontrollera nu after appointing directly at Skatteverket on an earlier day says it does not count, never waiting', () => {
    expect(ombudCheckOutcome(predates, { justSigned: false })).toBe('predates')
  })

  it('back from signing, an older or withdrawn grant only means the new signature is not listed yet', () => {
    expect(ombudCheckOutcome(predates, { justSigned: true })).toBe('waiting')
    expect(ombudCheckOutcome(withdrawn, { justSigned: true })).toBe('waiting')
  })
})
