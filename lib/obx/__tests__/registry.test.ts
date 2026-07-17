import { describe, expect, it } from 'vitest'
import { verifyAgainstObxRegistry } from '@/lib/obx/registry'

describe('obx registry verify', () => {
  it('returns NOT_FOUND when no hash', async () => {
    const result = await verifyAgainstObxRegistry({} as never, {})
    expect(result.status).toBe('NOT_FOUND')
  })

  it('returns VERIFIED when row matches', async () => {
    const supabase = {
      from() {
        return {
          select() {
            return {
              limit() {
                return {
                  eq() {
                    return this
                  },
                  then(resolve: (v: unknown) => void) {
                    resolve({
                      data: [
                        {
                          id: '1',
                          company_id: 'c1',
                          fiscal_year: '2025',
                          manifest_hash: 'abc',
                          inner_manifest_hash: null,
                          chain_root: null,
                          org_number: null,
                          origin_system: null,
                          custody_json: [],
                          published_at: '2026-01-01T00:00:00Z',
                        },
                      ],
                      error: null,
                    })
                  },
                }
              },
            }
          },
        }
      },
    }

    // Build a thenable chain that supabase-js style awaits
    const chain: Record<string, unknown> = {}
    const api = {
      select: () => api,
      eq: () => api,
      limit: () => api,
      then(onFulfilled: (v: { data: unknown[]; error: null }) => unknown) {
        return Promise.resolve(
          onFulfilled({
            data: [
              {
                id: '1',
                company_id: 'c1',
                fiscal_year: '2025',
                manifest_hash: 'abc',
                inner_manifest_hash: null,
                chain_root: null,
                org_number: null,
                origin_system: null,
                custody_json: [],
                published_at: '2026-01-01T00:00:00Z',
              },
            ],
            error: null,
          }),
        )
      },
    }
    void chain
    void supabase

    const result = await verifyAgainstObxRegistry(
      { from: () => api } as never,
      { companyId: 'c1', manifestHash: 'abc' },
    )
    expect(result.status).toBe('VERIFIED')
    expect(result.match?.manifest_hash).toBe('abc')
  })
})
