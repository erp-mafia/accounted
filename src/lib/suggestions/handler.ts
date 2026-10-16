/**
 * The event side of suggestions: the event detectors subscribe to the bus
 * next to the event_log and webhook handlers (lib/init registers all three),
 * so they run where every event already runs, once per event and for the
 * one company it names. No scan over companies.
 *
 * Never throws at the emitter: the write that emitted (an employee saved, a
 * till connected) has happened, and a suggestion that could not be made is
 * logged and dropped (./stage.ts also skips a database that does not have
 * the suggestion operations yet).
 */
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventBus } from '@/lib/events/bus'
import type { CoreEvent, CoreEventType } from '@/lib/events/types'
import { createLogger } from '@/lib/logger'
import { EVENT_DETECTORS } from './detectors'
import { createDetectorContext, runDetector } from './run'
import type { Detector } from './types'

const log = createLogger('suggestions')

/** The event detectors per event type they wake on. */
export function detectorsByEventType(
  detectors: readonly Detector<unknown>[] = EVENT_DETECTORS,
): Map<CoreEventType, Detector<unknown>[]> {
  const byType = new Map<CoreEventType, Detector<unknown>[]>()
  for (const detector of detectors) {
    if (detector.trigger.kind !== 'event') continue
    for (const type of detector.trigger.eventTypes) {
      const list = byType.get(type) ?? []
      list.push(detector)
      byType.set(type, list)
    }
  }
  return byType
}

/** Run every detector that wakes on this event, for the company it names. */
export async function runEventDetectors(
  event: CoreEvent,
  detectors: readonly Detector<unknown>[] = detectorsByEventType().get(event.type) ?? [],
): Promise<void> {
  const payload = event.payload as Record<string, unknown>
  const companyId = payload.companyId
  const userId = payload.userId
  if (typeof companyId !== 'string' || !companyId || typeof userId !== 'string' || !userId) return
  if (detectors.length === 0) return
  try {
    const ctx = createDetectorContext({
      supabase: createServiceClientNoCookies(),
      companyId,
      userId,
      log,
    })
    for (const detector of detectors) {
      await runDetector(detector, ctx, event)
    }
  } catch (err) {
    log.error('suggestion detectors failed for an event', err instanceof Error ? err : new Error(String(err)), {
      eventType: event.type,
      companyId,
    })
  }
}

/**
 * Subscribe the event detectors. Called once by lib/init's
 * ensureInitialized(); returns the unsubscribe functions.
 */
export function registerSuggestionDetectorHandler(): (() => void)[] {
  return [...detectorsByEventType().entries()].map(([type, detectors]) =>
    eventBus.on(type, (payload) => runEventDetectors({ type, payload } as CoreEvent, detectors)),
  )
}
