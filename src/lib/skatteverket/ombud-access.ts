/**
 * Core <-> Skatteverket-extension boundary for the ombud (system auth) state.
 *
 * When Accounted is a company's ombud at Skatteverket, its background reads
 * (skattekonto, kvittenser) run on Accounted's own certificate and the
 * personal BankID session stops mattering for them. Core surfaces that would
 * otherwise nag about that session (Hem, the reconnect notice, onboarding)
 * ask here. `lib/` cannot import from `@/extensions/` (CI guard), so the
 * answer comes through the registry-resolved `services` channel, the same
 * seam as ./extension-actions.ts. With the extension absent or not wired,
 * both answers are "no": exactly today's BankID-only behaviour.
 */
import { extensionRegistry } from '@/lib/extensions/registry'
import { createLogger } from '@/lib/logger'
import type { OmbudAppointment } from './ombud-appointment'

const log = createLogger('skatteverket-ombud-access')

/** What a fully wired skatteverket extension exposes on `services` for this. */
export interface SkatteverketOmbudServices {
  /** System auth is on in this deployment: companies can appoint Accounted and reads use it. */
  isOmbudEnabled: () => Promise<boolean>
  /** This company's background reads run on its verified ombud grant. */
  hasOmbudReadAccess: (companyId: string) => Promise<boolean>
  /** Where the company's appointment stands (./ombud-appointment.ts). */
  getOmbudAppointment: (companyId: string) => Promise<OmbudAppointment>
}

async function services(): Promise<Partial<SkatteverketOmbudServices> | undefined> {
  return (await extensionRegistry.get('skatteverket'))?.services as Partial<SkatteverketOmbudServices> | undefined
}

/** True when companies should be offered "Utse Accounted som ombud" instead of a BankID login. */
export async function isSkatteverketOmbudEnabled(): Promise<boolean> {
  const check = (await services())?.isOmbudEnabled
  if (!check) return false
  try {
    return await check()
  } catch {
    return false
  }
}

/**
 * True when the company's Skatteverket reads run through Accounted as ombud.
 * Best-effort: a lookup failure answers false, which only means the BankID
 * prompts behave as they did before ombud existed.
 */
export async function hasSkatteverketOmbudReadAccess(companyId: string): Promise<boolean> {
  const check = (await services())?.hasOmbudReadAccess
  if (!check) return false
  try {
    return await check(companyId)
  } catch (err) {
    log.warn('ombud read access lookup failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Where the company's appointment of the app as ombud stands, so Hem and Kom
 * igång say "Väntar på Skatteverket" while the register has not listed a
 * fresh grant yet. Best-effort like the read-access answer: a failure reads
 * as not appointed, the state those surfaces showed before.
 */
export async function getSkatteverketOmbudAppointment(companyId: string): Promise<OmbudAppointment> {
  const check = (await services())?.getOmbudAppointment
  if (!check) return { state: 'none', predatesOptIn: false }
  try {
    return await check(companyId)
  } catch (err) {
    log.warn('ombud appointment lookup failed', {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { state: 'none', predatesOptIn: false }
  }
}
