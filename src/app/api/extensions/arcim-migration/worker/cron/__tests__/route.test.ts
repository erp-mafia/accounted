import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { enabled, worker } = vi.hoisted(() => ({ enabled: vi.fn(), worker: vi.fn() }))
vi.mock('@/lib/extensions/loader', () => ({ loadExtensions: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({ extensionRegistry: { get: enabled } }))
vi.mock('@/extensions/general/arcim-migration/lib/migration-job-worker', () => ({ runProviderMigrationWorker: worker }))
import { GET } from '../route'
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CRON_SECRET', 'migration-test-secret') })
afterEach(() => vi.unstubAllEnvs())
const request = (authorized = true) => new Request('http://localhost/api/extensions/arcim-migration/worker/cron', {
  headers: authorized ? { Authorization: 'Bearer migration-test-secret' } : {},
})
describe('provider worker cron', () => {
  it('requires scheduler authorization', async () => {
    expect((await GET(request(false))).status).toBe(401)
    expect(worker).not.toHaveBeenCalled()
  })
  it('does not run a disabled extension', async () => {
    enabled.mockReturnValue(undefined)
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { skipped: 'extension_disabled' } })
    expect(worker).not.toHaveBeenCalled()
  })
  it('runs without a browser or user session and reports its checkpoints', async () => {
    enabled.mockReturnValue({ id: 'arcim-migration' }); worker.mockResolvedValue({ jobs: 1, batches: 20 })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { jobs: 1, batches: 20 } })
    expect(worker).toHaveBeenCalledOnce()
  })
})
