import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { Logger } from '@/lib/logger'
import { CAPABILITY } from '@/lib/entitlements/keys'

vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn(async () => true) }))

import { runWebshopOrderCron, type WebshopOrderCronSpec } from '../order-cron'

type Connection = { id: string; company_id: string }

describe('runWebshopOrderCron without credentials (accounted#115)', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; child: ReturnType<typeof vi.fn> }
  const sync = vi.fn()
  const spec: WebshopOrderCronSpec<Connection> = {
    extensionId: 'shopify',
    label: 'Shopify',
    table: 'shopify_connections',
    capability: CAPABILITY.shopify_sync,
    isConfigured: () => false,
    sync,
  }

  async function run() {
    const ctx = { requestId: 'cron_1', log: log as unknown as Logger, supabase: mock.supabase as unknown as SupabaseClient }
    const response = await runWebshopOrderCron(ctx, spec)
    return { status: response.status, body: await response.json() }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }
  })

  it('reports an error when connections with sync on go unsynced, and answers as before', async () => {
    mock.enqueue({ count: 3 })

    expect(await run()).toEqual({ status: 200, body: { message: 'Shopify not configured', processed: 0 } })

    expect(mock.findCall('shopify_connections', 'select')).toEqual(['id', { count: 'exact', head: true }])
    expect(mock.findCalls('shopify_connections', 'eq')).toEqual([['status', 'active'], ['transaction_sync_enabled', true]])
    expect(log.error).toHaveBeenCalledWith('Shopify is not configured; connections with sync on are not synced', {
      extensionId: 'shopify',
      alert: true,
      connections: 3,
    })
    expect(sync).not.toHaveBeenCalled()
  })

  it('says why it did nothing, at info, when no connection expects a sync', async () => {
    mock.enqueue({ count: 0 })

    expect((await run()).body.processed).toBe(0)

    expect(log.error).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith('Shopify is not configured and no connection has sync on; nothing to sync', {
      extensionId: 'shopify',
    })
  })

  it('reports an error when the connections cannot be counted', async () => {
    mock.enqueue({ error: { message: 'permission denied for table shopify_connections' } })

    expect((await run()).status).toBe(200)

    expect(log.error).toHaveBeenCalledWith('Shopify is not configured, and its connections could not be counted',
      expect.objectContaining({ message: 'permission denied for table shopify_connections' }),
      { extensionId: 'shopify', alert: true })
  })
})
