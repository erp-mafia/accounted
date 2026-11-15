'use client'

import { useEffect, useRef } from 'react'
import { captureAnalyticsEvent } from '@/lib/analytics/client'
import { nextStepEvent, ONBOARDING_STEP_EVENT, type OnboardingStepInput } from '@/lib/onboarding/step-event'

/**
 * Sends `onboarding_step_viewed` once per step entry (lib/onboarding/step-event).
 * A no-op while analytics is off for this person. Never throws: telemetry
 * must never affect the journey.
 */
export function useOnboardingStepEvent(input: OnboardingStepInput): void {
  const lastKey = useRef<string | null>(null)
  const { journey, step, ready, mode, entityType, path, provider } = input

  useEffect(() => {
    const event = nextStepEvent(lastKey.current, { journey, step, ready, mode, entityType, path, provider })
    if (!event) return
    lastKey.current = event.key
    captureAnalyticsEvent(ONBOARDING_STEP_EVENT, event.properties)
  }, [journey, step, ready, mode, entityType, path, provider])
}
