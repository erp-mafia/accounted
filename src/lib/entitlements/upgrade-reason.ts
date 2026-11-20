import { CAPABILITY, type CapabilityKey } from './keys'

/**
 * Why someone landed on Inställningar > Abonnemang without asking for it.
 *
 * A gated section that sends a company without the capability to the billing
 * page passes its reason in the query string (`?from=assistant`), and the page
 * says in one line what brought the person there. A normal visit carries no
 * reason and shows nothing.
 *
 * The value arrives in a URL, so it is only ever matched against this fixed
 * list: an unknown, repeated or malformed value is no reason at all, and the
 * text shown always comes from the message catalogue, never from the URL.
 *
 * To give another gated section its own line: add an entry here with the
 * capability that gates it and a `settings_billing` message key (sv and en),
 * and link to `billingHref('<reason>')` from its redirect.
 */
export const UPGRADE_REASON_PARAM = 'from'

export const UPGRADE_REASONS = {
  assistant: { capability: CAPABILITY.ai, messageKey: 'landed_from_assistant' },
} as const satisfies Record<string, { capability: CapabilityKey; messageKey: string }>

export type UpgradeReason = keyof typeof UPGRADE_REASONS

/** The reason a `?from=` value names, or null when it names none. */
export function parseUpgradeReason(raw: unknown): UpgradeReason | null {
  if (typeof raw !== 'string') return null
  return Object.hasOwn(UPGRADE_REASONS, raw) ? (raw as UpgradeReason) : null
}

/** The billing page address that carries a reason. */
export function billingHref(reason: UpgradeReason): string {
  return `/settings/billing?${UPGRADE_REASON_PARAM}=${reason}`
}
