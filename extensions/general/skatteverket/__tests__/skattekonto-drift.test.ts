import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  computeSkattekontoDrift,
  maybeAlertDrift,
} from '../lib/skattekonto-drift'

function fakeCtx(overrides: {
  supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  settings: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; clear?: ReturnType<typeof vi.fn> }
  emit?: ReturnType<typeof vi.fn>
}) {
  return {
    userId: 'user-1',
    companyId: 'company-1',
    extensionId: 'skatteverket',
    supabase: overrides.supabase,
    emit: overrides.emit ?? vi.fn().mockResolvedValue(undefined),
    settings: {
      get: overrides.settings.get,
      set: overrides.settings.set,
      clear: overrides.settings.clear ?? vi.fn(),
    },
    storage: {} as unknown,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown,
    services: {} as unknown,
  } as unknown as Parameters<typeof computeSkattekontoDrift>[0]
}

describe('computeSkattekontoDrift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when no snapshot has been cached', async () => {
    const { supabase } = createQueuedMockSupabase()
    const ctx = fakeCtx({
      supabase,
      settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
    })

    const drift = await computeSkattekontoDrift(ctx)
    expect(drift).toBeNull()
  })

  it('computes drift = saldoSkatteverket - GL 1630 sum (positive when SKV ahead)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // GL 1630 query: 5000 SEK debit
    enqueue({
      data: [{ debit_amount: 5000, credit_amount: 0 }],
    })
    // Unbooked rows query
    enqueue({ data: [] })

    const ctx = fakeCtx({
      supabase,
      settings: {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'skattekonto_balance_snapshot') {
            return Promise.resolve({
              saldo: { saldoSkatteverket: 5500, saldoKronofogden: 0 },
              fetchedAt: new Date('2026-06-12T04:00:00Z').getTime(),
            })
          }
          return Promise.resolve(null)
        }),
        set: vi.fn(),
      },
    })

    const drift = await computeSkattekontoDrift(ctx)
    expect(drift).not.toBeNull()
    expect(drift!.saldoSkatteverket).toBe(5500)
    expect(drift!.glSum1630).toBe(5000)
    expect(drift!.drift).toBe(500)
    expect(drift!.tolerance).toBe(1)
  })

  it('honors a per-company override of the tolerance', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ debit_amount: 1000, credit_amount: 0 }] })
    enqueue({ data: [] })

    const ctx = fakeCtx({
      supabase,
      settings: {
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'skattekonto_balance_snapshot') {
            return Promise.resolve({
              saldo: { saldoSkatteverket: 1000.5, saldoKronofogden: 0 },
              fetchedAt: Date.now(),
            })
          }
          if (key === 'skattekonto_drift_tolerance') return Promise.resolve(100)
          return Promise.resolve(null)
        }),
        set: vi.fn(),
      },
    })

    const drift = await computeSkattekontoDrift(ctx)
    expect(drift!.tolerance).toBe(100)
  })
})

describe('maybeAlertDrift', () => {
  it('does NOT emit when |drift| <= tolerance', async () => {
    const { supabase } = createQueuedMockSupabase()
    const emit = vi.fn().mockResolvedValue(undefined)
    const ctx = fakeCtx({
      supabase,
      settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn() },
      emit,
    })
    const alerted = await maybeAlertDrift(ctx, {
      saldoSkatteverket: 100,
      glSum1630: 100.5,
      drift: -0.5,
      fetchedAt: Date.now(),
      tolerance: 1,
      unbookedRows: [],
    })
    expect(alerted).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('emits skattekonto.drift_detected on a fresh drift', async () => {
    const { supabase } = createQueuedMockSupabase()
    const emit = vi.fn().mockResolvedValue(undefined)
    const setSpy = vi.fn().mockResolvedValue(undefined)
    const ctx = fakeCtx({
      supabase,
      settings: { get: vi.fn().mockResolvedValue(null), set: setSpy },
      emit,
    })
    const alerted = await maybeAlertDrift(ctx, {
      saldoSkatteverket: 5000,
      glSum1630: 4000,
      drift: 1000,
      fetchedAt: Date.now(),
      tolerance: 1,
      unbookedRows: [],
    })
    expect(alerted).toBe(true)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'skattekonto.drift_detected' }),
    )
    expect(setSpy).toHaveBeenCalledWith(
      'skattekonto_drift_last_alert_at',
      expect.objectContaining({ lastSign: 1 }),
    )
  })

  it('suppresses repeat alerts within the 24h throttle when sign is unchanged', async () => {
    const { supabase } = createQueuedMockSupabase()
    const emit = vi.fn().mockResolvedValue(undefined)
    const now = Date.now()
    const ctx = fakeCtx({
      supabase,
      settings: {
        get: vi.fn().mockResolvedValue({
          lastAlertAt: now - 60 * 60 * 1000, // 1h ago
          lastSign: 1,
        }),
        set: vi.fn(),
      },
      emit,
    })
    const alerted = await maybeAlertDrift(ctx, {
      saldoSkatteverket: 5000,
      glSum1630: 4000,
      drift: 1000,
      fetchedAt: now,
      tolerance: 1,
      unbookedRows: [],
    })
    expect(alerted).toBe(false)
    expect(emit).not.toHaveBeenCalled()
  })

  it('re-alerts when the sign flips even within the throttle window', async () => {
    const { supabase } = createQueuedMockSupabase()
    const emit = vi.fn().mockResolvedValue(undefined)
    const ctx = fakeCtx({
      supabase,
      settings: {
        get: vi.fn().mockResolvedValue({
          lastAlertAt: Date.now() - 60 * 60 * 1000,
          lastSign: 1,
        }),
        set: vi.fn(),
      },
      emit,
    })
    const alerted = await maybeAlertDrift(ctx, {
      saldoSkatteverket: 3000,
      glSum1630: 4000,
      drift: -1000,
      fetchedAt: Date.now(),
      tolerance: 1,
      unbookedRows: [],
    })
    expect(alerted).toBe(true)
    expect(emit).toHaveBeenCalled()
  })
})
