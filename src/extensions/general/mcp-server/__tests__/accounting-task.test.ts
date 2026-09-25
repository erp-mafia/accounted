import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/agent-skills/catalog', () => ({ loadSkillCatalog: vi.fn(), loadCatalogSkill: vi.fn() }))
vi.mock('@/lib/agent-skills/agent-bundle', async (original) => ({ ...(await original<object>()), loadAgentBundle: vi.fn() }))
import { loadSkillCatalog, loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { loadAgentBundle } from '@/lib/agent-skills/agent-bundle'
import { getAccountingTask, INDUSTRY_SECTIONS_INSTRUCTION } from '../accounting-task'

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
  it('returns the whole agent for agent:<id>, with the agent rules first', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue({
      agent: { id: 'quarterly-vat-review', name: 'Momsdeklaration' },
      workflow: { slug: 'quarterly-vat-review', version: 4, body: '# Moms' },
      knowledge: [{ id: 'horizontal/swedish-vat', tier: 'horizontal', source: 'default', title: 'Swedish VAT', summary: '', version: 7, reviewed_at: null, body: '# VAT' }],
      industry_sections: [],
      references: [], company: [], connections: [{ kind: 'skatteverket', status: 'connected' }],
      company_knowledge: { name: 'Arcim', org_number: null, onboarding_summary: null, facts: [], remembered: [], documents: { total: 0, look_up: [] } },
    })
    const task = await getAccountingTask({ kind: 'agent:quarterly-vat-review', client: 'grok' }, 'company-a', {} as never)
    expect(loadAgentBundle).toHaveBeenCalledWith({}, 'company-a', 'quarterly-vat-review', 'grok')
    expect(task).toMatchObject({ kind: 'agent:quarterly-vat-review', skills: ['quarterly-vat-review', 'horizontal/swedish-vat'], workflow: { body: '# Moms' } })
    expect(task.instructions[0]).toContain('Accounted agent')
    expect(task.instructions).not.toContain(INDUSTRY_SECTIONS_INSTRUCTION)
    expect(loadSkillCatalog).not.toHaveBeenCalled()
  })
  it('presents the industry sections for the workflow after the knowledge and before the references', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue({
      agent: { id: 'invoicing-rules', name: 'Fakturera rätt' },
      workflow: { slug: 'invoicing-rules', version: 2, body: '# Faktura' },
      knowledge: [{ id: 'horizontal/swedish-invoice-compliance', tier: 'horizontal', source: 'default', title: 'Fakturering', summary: '', version: 3, reviewed_at: null, body: '# Regler' }],
      industry_sections: [{ id: 'vertical/konsult-it/invoice-templates', title: 'Invoice text library', parent_id: 'vertical/konsult-it', body: '# Fakturatexter' }],
      references: [{ id: 'horizontal/swedish-invoice-compliance/invoice-rules', title: 'Invoice rules' }],
      company: [{ id: 'vertical/konsult-it', title: 'IT-konsult', tier: 'vertical' }], connections: [],
      company_knowledge: { name: 'Arcim', org_number: null, onboarding_summary: null, facts: [], remembered: [], documents: { total: 0, look_up: [] } },
    })
    const task = await getAccountingTask({ kind: 'agent:invoicing-rules' }, 'company-a', {} as never)
    expect(task.skills).toEqual(['invoicing-rules', 'horizontal/swedish-invoice-compliance', 'vertical/konsult-it/invoice-templates'])
    expect(task.instructions[2]).toBe(INDUSTRY_SECTIONS_INSTRUCTION)
    expect(INDUSTRY_SECTIONS_INSTRUCTION).toContain('Er bransch, för det här arbetsflödet')
    const keys = Object.keys(task)
    expect(keys.indexOf('knowledge')).toBeLessThan(keys.indexOf('industry_sections'))
    expect(keys.indexOf('industry_sections')).toBeLessThan(keys.indexOf('references'))
    expect(JSON.stringify(task)).toContain('# Fakturatexter')
  })
  it('rejects an unknown agent', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(null)
    await expect(getAccountingTask({ kind: 'agent:nope' }, 'company-a', {} as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('asks "fungerade det?" at the end of a community flow, and only there', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: 'community/stang-dagskassan', name: 'Stäng dagskassan', tier: 'community', summary: '', tags: [], body: '# Steg' })
    const shared = await getAccountingTask({ kind: 'skill:community/stang-dagskassan' }, 'company-a', {} as never)
    const closing = shared.instructions.at(-1)!
    expect(closing).toContain('Fungerade det?')
    expect(closing).toContain('gnubok_feedback')
    expect(closing).toContain('skill_slug "community/stang-dagskassan", upvote true')
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: 'month-end-close', name: 'Månadsbokslut', tier: 'workflow', summary: '', tags: [], body: '# Steg' })
    const curated = await getAccountingTask({ kind: 'skill:month-end-close' }, 'company-a', {} as never)
    expect(curated.instructions.join(' ')).not.toContain('Fungerade det?')
  })
  it('resolves own slugs only inside the authorized company catalog', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue(null)
    await expect(getAccountingTask({ kind: 'skill:own/missing' }, 'company-a', {} as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(loadCatalogSkill).toHaveBeenCalledWith({}, 'company-a', 'own/missing')
  })
})
