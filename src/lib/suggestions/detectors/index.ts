/**
 * Every built-in detector. A new one is added here and nowhere else: the
 * event consumer (../handler.ts) subscribes to the event types the event
 * detectors name, and the daily sweep (../sweep.ts) runs the scheduled ones.
 */
import type { Detector } from '../types'
import { firstEmployeeDetector } from './first-employee'
import { grantCandidateDetector } from './grant-candidate'
import { hideUnusedDetector } from './hide-unused'
import { salesChannelConnectedDetector } from './sales-channel-connected'

export const DETECTORS: readonly Detector<unknown>[] = Object.freeze([
  firstEmployeeDetector,
  salesChannelConnectedDetector,
  hideUnusedDetector,
  grantCandidateDetector,
])

export const EVENT_DETECTORS: readonly Detector<unknown>[] = DETECTORS.filter((d) => d.trigger.kind === 'event')
export const SCHEDULED_DETECTORS: readonly Detector<unknown>[] = DETECTORS.filter((d) => d.trigger.kind === 'schedule')

export { firstEmployeeDetector, grantCandidateDetector, hideUnusedDetector, salesChannelConnectedDetector }
