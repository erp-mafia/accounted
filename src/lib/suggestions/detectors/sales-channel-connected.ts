/**
 * "Slå på Kassa och webbshop?": a till (kassasystem) or a webshop is
 * connected while the company has Kassa och webbshop switched off.
 *
 * Wakes on pos.connected (lib/pos-sales/service.ts connectPosVenue) and on
 * the webshop connections' events (shopify.connected, woocommerce.connected,
 * zettle.connected). One key for all of them: the package is one switch.
 * The package is off only where a profile or the company left it off, which
 * today means a byrå-profiled company: existing Standard companies see
 * nothing new.
 */
import type { CoreEventType } from '@/lib/events/types'
import { enablePackageProposal, packageIsOff, SUGGESTION_RANKS } from '../package-proposals'
import type { Detector } from '../types'

/** Which kind of connection woke it, for the reason's first sentence. */
type Channel = 'pos' | 'webshop'

interface Subject {
  packageId: 'pos-and-webshop'
  channel: Channel
}

/** The connection events this detector wakes on, and what each connects. Zettle is a till. */
const CHANNEL_BY_EVENT: Partial<Record<CoreEventType, Channel>> = {
  'pos.connected': 'pos',
  'zettle.connected': 'pos',
  'shopify.connected': 'webshop',
  'woocommerce.connected': 'webshop',
}

const FIRST_SENTENCE: Record<Channel, string> = {
  pos: 'Du har kopplat ett kassasystem.',
  webshop: 'Du har kopplat en webbshop.',
}

export const salesChannelConnectedDetector: Detector<Subject> = {
  id: 'sales-channel-connected',
  trigger: { kind: 'event', eventTypes: Object.keys(CHANNEL_BY_EVENT) as CoreEventType[] },
  subjects: (_ctx, event) => {
    const channel = event ? CHANNEL_BY_EVENT[event.type] : undefined
    return channel ? [{ packageId: 'pos-and-webshop', channel }] : []
  },
  condition: (ctx, subject) => packageIsOff(ctx, subject.packageId),
  propose: (subject) =>
    enablePackageProposal(subject.packageId, {
      reason: `${FIRST_SENTENCE[subject.channel]} Med Kassa och webbshop hämtas försäljningen in och bokförs med underlag.`,
      rank: SUGGESTION_RANKS.enableSalesChannels,
    }),
}
