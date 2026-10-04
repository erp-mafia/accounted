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

const log = createLogger('skatteverket-ombud-access')

/** What a fully wired skatteverket extension exposes on `services` for this. */
export interface SkatteverketOmbudServices {
  /** System auth is on in this deployment: companies can appoint Accounted and reads use it. */
  isOmbudEnabled: () => Promise<boolean>
  /** This company's background reads run on its verified ombud grant. */
  hasOmbudReadAccess: (companyId: string) => Promise<boolean>
}

function services(): Partial<SkatteverketOmbudServices> | undefined {
  return extensionRegistry.get('skatteverket')?.services as Partial<SkatteverketOmbudServices> | undefined
}

/** True when companies should be offered "Utse Accounted som ombud" instead of a BankID login. */
export async function isSkatteverketOmbudEnabled(): Promise<boolean> {
  const check = services()?.isOmbudEnabled
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
  const check = services()?.hasOmbudReadAccess
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
