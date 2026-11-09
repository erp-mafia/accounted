/**
 * Where a company's appointment of the app as its ombud at Skatteverket
 * stands, in the states every surface shows: the settings card, the Hem chip,
 * the Kom igång step and the toasts after signing. Pure, so the extension
 * (which owns the connection row) and core's pages read it the same way.
 *
 * Nothing calls back when a company signs at Skatteverket, and Skatteverket
 * can take from minutes to hours before its ombudsregister lists the grant.
 * Until then the register has nothing for the company, which the connection
 * row records as 'denied'. That is a wait, not a failure: only a grant that
 * counted on this opt-in and no longer does is one, marked 'withdrawn' by
 * recordProbeResult in the skatteverket extension's connection-store
 * (Skatteverket withdrew it, or the org-number claim rule holds it back).
 */

export type OmbudRole = 'lasombud' | 'moms_ombud'

/** One behörighet, once the register has answered anything for the company. */
export type OmbudRoleState =
  /** In the ombudsregister, signed on or after the company's opt-in. */
  | 'granted'
  /** Never granted on this opt-in, while something else is (or was). */
  | 'not_included'
  /** It counted on this opt-in and no longer does (withdrawn at Skatteverket, or held back). */
  | 'withdrawn'
  /** The last check could not ask Skatteverket. */
  | 'error'

/** `predatesOptIn`: a behörighet is active at Skatteverket but was signed before the opt-in. */
export type OmbudAppointment =
  /**
   * Not appointed: no opt-in, the company's own "Koppla från", or only a
   * grant signed before the opt-in, which does not count.
   */
  | { state: 'none'; predatesOptIn: boolean }
  /** Opted in, and Skatteverket has registered nothing on this opt-in yet. */
  | { state: 'waiting'; predatesOptIn: false }
  /** 'appointed': at least one behörighet granted. 'withdrawn': none now, and one was. */
  | { state: 'appointed' | 'withdrawn'; roles: Record<OmbudRole, OmbudRoleState>; predatesOptIn: boolean }

/** The columns of a skatteverket_company_connections row the state is read from. */
export interface OmbudConnectionFacts {
  status: string
  lasombud_status: string
  moms_ombud_status: string
  last_probe_detail?: Record<string, unknown> | null
}

const ROLES: readonly OmbudRole[] = ['lasombud', 'moms_ombud']

function storedReason(connection: OmbudConnectionFacts, role: OmbudRole): unknown {
  const detail = connection.last_probe_detail?.[role]
  return detail && typeof detail === 'object' ? (detail as { reason?: unknown }).reason : undefined
}

export function ombudAppointment(connection: OmbudConnectionFacts | null): OmbudAppointment {
  if (!connection || connection.status === 'revoked') return { state: 'none', predatesOptIn: false }
  const roleState = (role: OmbudRole): OmbudRoleState => {
    const status = role === 'lasombud' ? connection.lasombud_status : connection.moms_ombud_status
    if (status === 'granted') return 'granted'
    if (storedReason(connection, role) === 'withdrawn') return 'withdrawn'
    if (status === 'error') return 'error'
    return 'not_included'
  }
  const roles = { lasombud: roleState('lasombud'), moms_ombud: roleState('moms_ombud') }
  const predatesOptIn = ROLES.some((role) => storedReason(connection, role) === 'predates_opt_in')
  const states = ROLES.map((role) => roles[role])
  if (states.includes('granted')) return { state: 'appointed', roles, predatesOptIn }
  if (states.includes('withdrawn')) return { state: 'withdrawn', roles, predatesOptIn }
  return predatesOptIn ? { state: 'none', predatesOptIn } : { state: 'waiting', predatesOptIn: false }
}

/**
 * What the check on the return from signing through the deep link tells the
 * person, in the words the card uses. läsombud decides 'granted': the
 * background reads run on it. Anything short of it is a wait: the link's
 * opt-in cleared any withdrawal, and an older grant that predates the opt-in
 * only means the new signature is not listed yet. Skatteverket takes minutes
 * to over an hour to register it, never a failure: the hourly ombud sync
 * picks it up. (A company that appointed the app some other way finds out
 * from the appoint button itself, which asks the register before it hands
 * out a link.)
 */
export type OmbudCheckOutcome = 'granted' | 'waiting'

export function ombudCheckOutcome(connection: OmbudConnectionFacts | null): OmbudCheckOutcome {
  const appointment = ombudAppointment(connection)
  return 'roles' in appointment && appointment.roles.lasombud === 'granted' ? 'granted' : 'waiting'
}
