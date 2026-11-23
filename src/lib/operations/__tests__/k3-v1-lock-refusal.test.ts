/**
 * The v1 doors of the K3 posting operations (lib/operations/k3.ts) through
 * the real route modules: a posting function's own lock refusal, raised when
 * the year was locked (or the lock date moved) between the service's checks
 * and the commit, answers 400 PERIOD_LOCKED as the triggers' refusal does,
 * not the retryable 500 BOOKKEEPING_DATABASE_ERROR. The services are mocked
 * at their posting call; the error is the one the engine throws.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/bokslut/assets/value-adjustment-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/value-adjustment-service')>()),
  postValueAdjustment: vi.fn(),
}))
vi.mock('@/lib/bokslut/assets/component-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/assets/component-service')>()),
  replaceAssetComponent: vi.fn(),
}))
vi.mock('@/lib/bokslut/k3-transition/transition-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bokslut/k3-transition/transition-service')>()),
  commitK3TransitionPosting: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { postValueAdjustment } from '@/lib/bokslut/assets/value-adjustment-service'
import { replaceAssetComponent } from '@/lib/bokslut/assets/component-service'
import { commitK3TransitionPosting } from '@/lib/bokslut/k3-transition/transition-service'
import { POST as VALUE_ADJUSTMENT } from '@/app/api/v1/companies/[companyId]/assets/[id]/value-adjustments/route'
import { POST as REPLACE_COMPONENT } from '@/app/api/v1/companies/[companyId]/assets/[id]/components/[componentId]/replace/route'
import { POST as COMMIT_K3_TRANSITION } from '@/app/api/v1/companies/[companyId]/k3-transition/commit/route'
import { createTableMockSupabase } from '@/tests/helpers'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ASSET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COMPONENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PERIOD_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`

function postRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'abcd1234-4444-4abc-8def-1234567890ab',
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(createServiceClientNoCookies).mockReturnValue(
    createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    }).supabase as never,
  )
  vi.mocked(validateApiKey).mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  } as never)
})

async function errorOf(response: Response) {
  return { status: response.status, code: ((await response.json()) as { error: { code: string } }).error.code }
}

describe('v1 K3 posting doors: a lock refusal from the posting function', () => {
  it('POST /assets/{id}/value-adjustments answers 400 PERIOD_LOCKED', async () => {
    vi.mocked(postValueAdjustment).mockRejectedValue(
      new BookkeepingDatabaseError('commit_asset_value_adjustment', 'Cannot adjust an asset in a locked or closed fiscal period', '23514'),
    )
    const response = await VALUE_ADJUSTMENT(
      postRequest(`${BASE}/assets/${ASSET_ID}/value-adjustments`, {
        kind: 'impairment',
        fiscal_period_id: PERIOD_ID,
        recoverable_amount: 600_000,
        reason: 'Marknadsvärdet har fallit (K3 27.4).',
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: ASSET_ID }) },
    )

    expect(await errorOf(response)).toEqual({ status: 400, code: 'PERIOD_LOCKED' })
    expect(postValueAdjustment).toHaveBeenCalledOnce()
  })

  it('POST /assets/{id}/components/{componentId}/replace answers 400 PERIOD_LOCKED', async () => {
    vi.mocked(replaceAssetComponent).mockRejectedValue(
      new BookkeepingDatabaseError('commit_asset_component_replacement', 'Bookkeeping is locked through 2026-06-30', '23514'),
    )
    const response = await REPLACE_COMPONENT(
      postRequest(`${BASE}/assets/${ASSET_ID}/components/${COMPONENT_ID}/replace`, {
        replaced_at: '2026-06-30',
        fiscal_period_id: PERIOD_ID,
      }),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: ASSET_ID, componentId: COMPONENT_ID }) },
    )

    expect(await errorOf(response)).toEqual({ status: 400, code: 'PERIOD_LOCKED' })
    expect(replaceAssetComponent).toHaveBeenCalledOnce()
  })

  it('POST /k3-transition/commit answers 400 PERIOD_LOCKED', async () => {
    vi.mocked(commitK3TransitionPosting).mockRejectedValue(
      new BookkeepingDatabaseError('commit_k3_transition', 'Cannot book the K3 transition in a locked or closed fiscal period', '23514'),
    )
    const response = await COMMIT_K3_TRANSITION(postRequest(`${BASE}/k3-transition/commit`, {}), {
      params: Promise.resolve({ companyId: COMPANY_ID }),
    })

    expect(await errorOf(response)).toEqual({ status: 400, code: 'PERIOD_LOCKED' })
    expect(commitK3TransitionPosting).toHaveBeenCalledOnce()
  })
})
