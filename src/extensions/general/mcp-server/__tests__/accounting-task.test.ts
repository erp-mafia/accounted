import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/agent-skills/catalog', () => ({ loadSkillCatalog: vi.fn(), loadCatalogSkill: vi.fn() }))
import { loadSkillCatalog, loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { getAccountingTask } from '../accounting-task'

describe('get_task', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadSkillCatalog).mockResolvedValue([
      { slug: 'horizontal/swedish-vat', tier: 'horizontal', active: true },
      { slug: 'own/tenant-skill', tier: 'own', active: true },
      { slug: 'community/not-installed', tier: 'community', active: false },
    ] as never)
  })
  it('orders the workflow before active company skills', async () => {
    const task = await getAccountingTask({ kind: 'bookkeep', scope: { transaction_ids: [] } }, 'company-a', {} as never)
    expect(task.skills).toEqual(['bookkeep', 'horizontal/swedish-vat', 'own/tenant-skill'])
    expect(task.scope.transaction_ids).toEqual([])
    expect(loadSkillCatalog).toHaveBeenCalledWith({}, 'company-a')
  })
  it.each([{ kind: 'random' }, { kind: 'bookkeep', scope: { date_from: '2026-02-30' } }, { kind: 'vat', scope: { date_from: '2026-02-01', date_to: '2026-01-01' } }, { kind: 'bookkeep', scope: { transaction_ids: ['not-uuid'] } }, { kind: 'start', unexpected: 1 }])('rejects invalid task input %j', async (input) => {
    await expect(getAccountingTask(input, 'company', {} as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(loadSkillCatalog).not.toHaveBeenCalled()
  })
  it('resolves own slugs only inside the authorized company catalog', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue(null)
    await expect(getAccountingTask({ kind: 'skill:own/missing' }, 'company-a', {} as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(loadCatalogSkill).toHaveBeenCalledWith({}, 'company-a', 'own/missing')
  })
})
