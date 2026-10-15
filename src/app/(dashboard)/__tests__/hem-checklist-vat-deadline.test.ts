/**
 * The Hem checklist's next momsdeklaration is the first one due on or after
 * the Swedish calendar day (accounted#18). 23:30 UTC is already the next day
 * in Stockholm, in summer (UTC+2) and in winter (UTC+1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { auth } = vi.hoisted(() => ({ auth: { supabase: null as unknown } }))

vi.mock('../request-context', () => ({ getDashboardAuthContext: async () => auth }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(), createClient: vi.fn() }))
vi.mock('@/lib/skatteverket/ombud-access', () => ({
  hasSkatteverketOmbudReadAccess: vi.fn(async () => false),
  isSkatteverketOmbudEnabled: vi.fn(async () => false),
}))
vi.mock('@/lib/providers/unfinished-connect', () => ({ findUnfinishedConnect: vi.fn(async () => null) }))
vi.mock('@/components/onboarding/NewUserChecklist', () => ({ default: () => null }))
vi.mock('@/components/dashboard/AttGoraSection', () => ({ default: () => null }))
vi.mock('@/components/dashboard/ResumePane', () => ({ default: () => null }))
vi.mock('@/components/dashboard/HemNotices', () => ({ HemNotices: () => null }))
vi.mock('@/lib/worklist', () => ({}))
vi.mock('@/lib/worklist/resume', () => ({}))
vi.mock('@/lib/worklist/missing-underlag', () => ({}))
vi.mock('@/lib/notices', () => ({}))
vi.mock('@/lib/notices/categories', () => ({}))

import { HemChecklistSection } from '../hem-sections'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HemChecklistSection: next momsdeklaration from the Swedish day', () => {
  it.each([
    ['summer', '2026-07-01T23:30:00Z', '2026-07-02'],
    ['winter', '2026-01-15T23:30:00Z', '2026-01-16'],
  ])('%s: at %s it reads deadlines due from %s', async (_season, instant, today) => {
    const mock = createQueuedMockSupabase()
    auth.supabase = mock.supabase

    await HemChecklistSection({
      companyId: 'company-1',
      userId: 'user-1',
      now: new Date(instant),
      initialSetup: {} as never,
      hasMcpKey: false,
      vatRegistered: true,
      momsPeriod: 'quarterly' as never,
    })

    expect(mock.findCall('deadlines', 'gte')).toEqual(['due_date', today])
  })
})
