import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/agent-skills/catalog', () => ({ loadSkillCatalog: vi.fn(), loadCatalogSkill: vi.fn() }))
vi.mock('@/lib/agent-skills/agent-bundle', async (original) => ({ ...(await original<object>()), loadAgentBundle: vi.fn() }))
vi.mock('../company-routing', async (original) => ({ ...(await original<object>()), resolveMcpCompanyContext: vi.fn() }))
import { loadSkillCatalog, loadCatalogSkill } from '@/lib/agent-skills/catalog'
import { loadAgentBundle, type AgentBundle } from '@/lib/agent-skills/agent-bundle'
import { analysisSkills, DASHBOARD_RULES } from '@/lib/agent-skills/analyses'
import { ACCOUNTING_TASK_INSTRUCTIONS } from '@/lib/ai-handoff/tasks'
import { codedError, resolveMcpCompanyContext } from '../company-routing'
import {
  ACCOUNTING_TASK_INPUT_SCHEMA,
  AGENT_INSTRUCTIONS,
  ANALYSIS_INSTRUCTIONS,
  getAccountingTask,
  INDUSTRY_SECTIONS_INSTRUCTION,
  UNATTENDED_ANALYSIS_INSTRUCTION,
  UNATTENDED_GOAL,
  UNATTENDED_INSTRUCTION,
  type AgentTask,
  type AnalysisTask,
} from '../accounting-task'

const OWN = '11111111-2222-4333-8444-555555555555'

/**
 * A Supabase stub that answers the three reads get_task makes itself: the
 * company name, the key's stored client and an own item's company. Each
 * table answers `rows[table]`; every call is recorded.
 */
function db(rows: Partial<Record<'companies' | 'api_keys' | 'company_skills', unknown>> = {}) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  return {
    calls,
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq']) chain[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return chain }
      chain.maybeSingle = async () => ({ data: (rows as Record<string, unknown>)[table] ?? null, error: null })
      return chain
    },
  }
}

const bundle = (extra: Partial<AgentBundle> = {}): AgentBundle => ({
  agent: { id: 'quarterly-vat-review', name: 'Momsdeklaration' },
  workflow: { slug: 'quarterly-vat-review', version: 4, body: '# Moms' },
  knowledge: [{ id: 'horizontal/swedish-vat', tier: 'horizontal', source: 'default', title: 'Swedish VAT', summary: '', version: 7, reviewed_at: null, body: '# VAT' }],
  industry_sections: [],
  references: [], company: [], connections: [{ kind: 'skatteverket', status: 'connected' }],
  company_knowledge: { name: 'Arcim', org_number: null, onboarding_summary: null, facts: [], remembered: [], documents: { total: 0, look_up: [] } },
  ...extra,
})

/** Every instruction a scheduled run gets, except the one that says not to ask, must not wait for a person. */
function assertNoOneIsAsked(task: { goal: string; instructions: string[] }, allowed: string) {
  expect(task.goal).not.toMatch(/clarify/i)
  for (const text of task.instructions.filter((i) => i !== allowed)) {
    expect(text, text).not.toMatch(/\bask\b|clarify|obtain the user's approval|say so before acting|Fungerade det/i)
  }
}

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
    const task = await getAccountingTask({ kind: 'bookkeep', scope: { transaction_ids: [] } }, 'company-a', db() as never)
    expect(task.skills).toEqual(['bookkeep', 'horizontal/swedish-vat', 'own/tenant-skill'])
    expect(task.scope.transaction_ids).toEqual([])
    expect(vi.mocked(loadSkillCatalog).mock.calls[0][1]).toBe('company-a')
  })
  it.each([{ kind: 'random' }, { kind: 'bookkeep', scope: { date_from: '2026-02-30' } }, { kind: 'vat', scope: { date_from: '2026-02-01', date_to: '2026-01-01' } }, { kind: 'bookkeep', scope: { transaction_ids: ['not-uuid'] } }, { kind: 'start', unexpected: 1 }, { kind: 'start', unattended: 'yes' }])('rejects invalid task input %j', async (input) => {
    await expect(getAccountingTask(input, 'company', db() as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(loadSkillCatalog).not.toHaveBeenCalled()
  })
  it('names the company first, so the AI says which books it works in', async () => {
    const task = await getAccountingTask({ kind: 'bookkeep' }, 'company-a', db({ companies: { name: 'Arcim Technology AB' } }) as never)
    expect(task.goal).toMatch(/^For Arcim Technology AB: /)
    expect(task.instructions[0]).toContain('This task is for Arcim Technology AB (company_id company-a): say so before you start.')
    expect(task.instructions[0]).toContain('Pass this company_id to every company-scoped tool')
    expect(task.instructions.slice(1)).toEqual([...ACCOUNTING_TASK_INSTRUCTIONS])
  })
  it('still routes by company_id when the name cannot be read', async () => {
    const task = await getAccountingTask({ kind: 'bookkeep' }, 'company-a', {} as never)
    expect(task.goal).toMatch(/^For this company: /)
    expect(task.instructions[0]).toContain('(company_id company-a)')
  })
  it('returns the whole agent for agent:<id>, with the company and the agent rules first', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(bundle())
    const task = await getAccountingTask({ kind: 'agent:quarterly-vat-review', client: 'grok' }, 'company-a', db() as never) as AgentTask
    expect(loadAgentBundle).toHaveBeenCalledWith(expect.anything(), 'company-a', 'quarterly-vat-review', 'grok')
    expect(task).toMatchObject({ kind: 'agent:quarterly-vat-review', built_for_client: 'grok', skills: ['quarterly-vat-review', 'horizontal/swedish-vat'], workflow: { body: '# Moms' } })
    expect(task.goal).toBe('Run the Momsdeklaration agent for Arcim. Clarify the objective before making changes.')
    expect(task.instructions[0]).toContain('This task is for Arcim')
    expect(task.instructions[1]).toContain('Accounted agent')
    expect(task.instructions).not.toContain(INDUSTRY_SECTIONS_INSTRUCTION)
    expect(loadSkillCatalog).not.toHaveBeenCalled()
  })
  it('never tells an agent to reload what the bundle already carries', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(bundle())
    const task = await getAccountingTask({ kind: 'agent:quarterly-vat-review' }, 'company-a', db() as never)
    const text = task.instructions.join('\n')
    expect(text).not.toContain(ACCOUNTING_TASK_INSTRUCTIONS[0])
    expect(text).not.toContain(ACCOUNTING_TASK_INSTRUCTIONS[1])
    expect(text).not.toMatch(/Load the listed workflow skills|Call gnubok_get_agent_briefing/)
    expect(text).toContain('Everything listed in `skills` is already included in this response: do not load it again.')
    for (const rest of ACCOUNTING_TASK_INSTRUCTIONS.slice(2)) expect(task.instructions).toContain(rest)
  })
  it('presents the industry sections for the workflow after the knowledge and before the references', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(bundle({
      agent: { id: 'invoicing-rules', name: 'Fakturera rätt' },
      workflow: { slug: 'invoicing-rules', version: 2, body: '# Faktura' },
      knowledge: [{ id: 'horizontal/swedish-invoice-compliance', tier: 'horizontal', source: 'default', title: 'Fakturering', summary: '', version: 3, reviewed_at: null, body: '# Regler' }],
      industry_sections: [{ id: 'vertical/konsult-it/invoice-templates', title: 'Invoice text library', parent_id: 'vertical/konsult-it', body: '# Fakturatexter' }],
      references: [{ id: 'horizontal/swedish-invoice-compliance/invoice-rules', title: 'Invoice rules' }],
      company: [{ id: 'vertical/konsult-it', title: 'IT-konsult', tier: 'vertical' }], connections: [],
    }))
    const task = await getAccountingTask({ kind: 'agent:invoicing-rules' }, 'company-a', db() as never)
    expect(task.skills).toEqual(['invoicing-rules', 'horizontal/swedish-invoice-compliance', 'vertical/konsult-it/invoice-templates'])
    expect(task.instructions[3]).toBe(INDUSTRY_SECTIONS_INSTRUCTION)
    expect(INDUSTRY_SECTIONS_INSTRUCTION).toContain('Er bransch, för det här arbetsflödet')
    const keys = Object.keys(task)
    expect(keys.indexOf('knowledge')).toBeLessThan(keys.indexOf('industry_sections'))
    expect(keys.indexOf('industry_sections')).toBeLessThan(keys.indexOf('references'))
    expect(JSON.stringify(task)).toContain('# Fakturatexter')
  })
  it('rejects an unknown agent', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(null)
    await expect(getAccountingTask({ kind: 'agent:nope' }, 'company-a', db() as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('asks "fungerade det?" at the end of a community flow, and only there', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: 'community/stang-dagskassan', name: 'Stäng dagskassan', tier: 'community', summary: '', tags: [], body: '# Steg' })
    const shared = await getAccountingTask({ kind: 'skill:community/stang-dagskassan' }, 'company-a', db() as never)
    const closing = shared.instructions.at(-1)!
    expect(closing).toContain('Fungerade det?')
    expect(closing).toContain('gnubok_feedback')
    expect(closing).toContain('skill_slug "community/stang-dagskassan", upvote true')
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: 'month-end-close', name: 'Månadsbokslut', tier: 'workflow', summary: '', tags: [], body: '# Steg' })
    const curated = await getAccountingTask({ kind: 'skill:month-end-close' }, 'company-a', db() as never)
    expect(curated.instructions.join(' ')).not.toContain('Fungerade det?')
  })
  it('resolves own slugs only inside the authorized company catalog', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue(null)
    await expect(getAccountingTask({ kind: 'skill:own/missing' }, 'company-a', db() as never)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(loadCatalogSkill).toHaveBeenCalledWith(expect.anything(), 'company-a', 'own/missing')
  })
})

describe('get_task: analyses get a real brief', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('builds an Accounted analysis now, read only, with its body inline and nothing else to load', async () => {
    const kassa = analysisSkills.find((s) => s.slug === 'analys-kassaprognos')!
    vi.mocked(loadCatalogSkill).mockResolvedValue(kassa)
    const task = await getAccountingTask({ kind: 'skill:analys-kassaprognos' }, 'company-a', db({ companies: { name: 'Arcim Technology AB' } }) as never) as AnalysisTask
    expect(task.goal).toBe('Build Kassaprognos 30 dagar for Arcim Technology AB now; ask only if data is missing.')
    expect(task.skills).toEqual(['analys-kassaprognos'])
    expect(task.analysis).toEqual({ slug: 'analys-kassaprognos', name: 'Kassaprognos 30 dagar', tier: 'workflow', version: 1, body: kassa.body })
    expect(task.instructions.slice(1)).toEqual([...ANALYSIS_INSTRUCTIONS])
    const text = task.instructions.join('\n')
    expect(text).toContain('Read only: change nothing in Accounted, stage no proposals and approve nothing.')
    expect(text).not.toMatch(/Prepare staged proposals|Load the listed workflow skills|Clarify the objective/)
    // The catalog is not needed: an analysis carries only itself.
    expect(loadSkillCatalog).not.toHaveBeenCalled()
  })

  it('adds the dashboard and read-only rules to an own analysis, whose author never wrote them', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: `own/${OWN}`, name: 'Kassalikviditet', summary: '', tags: ['own'], tier: 'own', source: 'own', itemKind: 'analysis', body: '# Kassalikviditet\n\nKlass 15-19 delat med klass 24-29.\n' })
    const task = await getAccountingTask({ kind: `skill:own/${OWN}` }, 'company-a', db() as never) as AnalysisTask
    expect(task.analysis.tier).toBe('own')
    expect(task.analysis.body).toBe(`# Kassalikviditet\n\nKlass 15-19 delat med klass 24-29.\n\n${DASHBOARD_RULES}\n`)
    expect(task.analysis.body).toContain('Ändra ingenting i Accounted och lägg inga förslag. En analys läser bara.')
  })

  it('does not add the rules twice to an analysis that has them', async () => {
    const overview = analysisSkills[0]
    vi.mocked(loadCatalogSkill).mockResolvedValue(overview)
    const task = await getAccountingTask({ kind: `skill:${overview.slug}` }, 'company-a', db() as never) as AnalysisTask
    expect(task.analysis.body.split('## Så byggs dashboarden')).toHaveLength(2)
  })

  it('keeps the generic brief for knowledge and flows started as skill:', async () => {
    vi.mocked(loadSkillCatalog).mockResolvedValue([])
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: `own/${OWN}`, name: 'Våra regler', summary: '', tags: ['own'], tier: 'own', source: 'own', itemKind: 'rules', body: '# Regler' })
    const task = await getAccountingTask({ kind: `skill:own/${OWN}` }, 'company-a', db() as never)
    expect(task).not.toHaveProperty('analysis')
    expect(task.goal).toContain('Use Våra regler for this company')
  })
})

describe('get_task: unattended (a routine, no one present)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadSkillCatalog).mockResolvedValue([])
  })

  it('is a boolean the wire schema lists', () => {
    expect(ACCOUNTING_TASK_INPUT_SCHEMA.properties.unattended).toEqual({ type: 'boolean' })
  })

  it('never asks, stages without approving and ends with a summary on an agent run', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(bundle({ industry_sections: [{ id: 'vertical/x/y', title: 'y', parent_id: 'vertical/x', body: '# Y' }] }))
    const task = await getAccountingTask({ kind: 'agent:quarterly-vat-review', unattended: true }, 'company-a', db() as never)
    expect(task.goal).toBe(`Run the Momsdeklaration agent for Arcim. ${UNATTENDED_GOAL}`)
    expect(UNATTENDED_GOAL).toBe('No one is present: do not ask; leave proposals for approval, never approve; end with a short summary.')
    expect(task.instructions[0]).toContain('name it at the top of your summary')
    expect(task.instructions[1]).toBe(UNATTENDED_INSTRUCTION)
    expect(UNATTENDED_INSTRUCTION).toContain('never call gnubok_approve_pending_operation')
    expect(task.instructions.join('\n')).toContain('leave them for the user to approve in Accounted. Never approve or commit anything yourself.')
    assertNoOneIsAsked(task, UNATTENDED_INSTRUCTION)
  })

  it('rewrites every waiting instruction on the generic kinds too, and drops "fungerade det?"', async () => {
    const plain = await getAccountingTask({ kind: 'month-close', unattended: true }, 'company-a', db() as never)
    expect(plain.goal).toContain(UNATTENDED_GOAL)
    assertNoOneIsAsked(plain, UNATTENDED_INSTRUCTION)
    vi.mocked(loadCatalogSkill).mockResolvedValue({ slug: 'community/stang-dagskassan', name: 'Stäng dagskassan', tier: 'community', summary: '', tags: [], body: '# Steg' })
    const shared = await getAccountingTask({ kind: 'skill:community/stang-dagskassan', unattended: true }, 'company-a', db() as never)
    expect(shared.goal).toBe(`Run Stäng dagskassan for this company. ${UNATTENDED_GOAL}`)
    assertNoOneIsAsked(shared, UNATTENDED_INSTRUCTION)
  })

  it('builds an analysis without a question and changes nothing', async () => {
    vi.mocked(loadCatalogSkill).mockResolvedValue(analysisSkills[1])
    const task = await getAccountingTask({ kind: 'skill:analys-kassaprognos', unattended: true }, 'company-a', db() as never)
    expect(task.goal).toBe('Build Kassaprognos 30 dagar for this company now. No one is present: do not ask; change nothing; end with the dashboard and a short summary.')
    expect(task.instructions[1]).toBe(UNATTENDED_ANALYSIS_INSTRUCTION)
    expect(task.instructions.join('\n')).toContain('build what you can and say what is missing')
    assertNoOneIsAsked(task, UNATTENDED_ANALYSIS_INSTRUCTION)
  })

  it('leaves an attended run exactly as it was', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(bundle())
    const attended = await getAccountingTask({ kind: 'agent:quarterly-vat-review' }, 'company-a', db() as never)
    const explicit = await getAccountingTask({ kind: 'agent:quarterly-vat-review', unattended: false }, 'company-a', db() as never)
    expect(explicit.instructions).toEqual(attended.instructions)
    expect(attended.instructions).toContain(AGENT_INSTRUCTIONS[1])
    expect(attended.instructions).not.toContain(UNATTENDED_INSTRUCTION)
  })
})

describe('get_task: an own item runs in the company that owns it', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('runs an own flow from company B when the key defaults to company A and the user is a member of B', async () => {
    vi.mocked(loadAgentBundle).mockImplementation(async (_s, companyId) => companyId === 'company-b'
      ? bundle({ agent: { id: `own/${OWN}`, name: 'Fredagskoll' }, workflow: { slug: `own/${OWN}`, version: null, body: '# Steg' }, company_knowledge: { ...bundle().company_knowledge, name: 'Bolag B AB' } })
      : null)
    vi.mocked(resolveMcpCompanyContext).mockResolvedValue({ companyId: 'company-b', role: 'member', isDefault: false })
    const supabase = db({ company_skills: { company_id: 'company-b' } })
    const task = await getAccountingTask({ kind: `agent:own/${OWN}` }, 'company-a', supabase as never, { userId: 'user-1' })
    expect(resolveMcpCompanyContext).toHaveBeenCalledWith({ supabase, userId: 'user-1', defaultCompanyId: 'company-a', requestedCompanyId: 'company-b' })
    expect(task.company_id).toBe('company-b')
    expect(task.goal).toContain('for Bolag B AB')
    expect(task.instructions[0]).toContain('This task is for Bolag B AB (company_id company-b)')
    expect(supabase.calls).toContainEqual({ table: 'company_skills', method: 'eq', args: ['id', OWN] })
  })

  it('resolves an own analysis the same way', async () => {
    vi.mocked(loadCatalogSkill).mockImplementation(async (_s, companyId) => companyId === 'company-b'
      ? { slug: `own/${OWN}`, name: 'Kassalikviditet', summary: '', tags: ['own'], tier: 'own', source: 'own', itemKind: 'analysis', body: '# K' }
      : null)
    vi.mocked(resolveMcpCompanyContext).mockResolvedValue({ companyId: 'company-b', role: 'viewer', isDefault: false })
    const task = await getAccountingTask({ kind: `skill:own/${OWN}` }, 'company-a', db({ company_skills: { company_id: 'company-b' }, companies: { name: 'Bolag B AB' } }) as never, { userId: 'user-1' })
    expect(task).toMatchObject({ company_id: 'company-b', goal: 'Build Kassalikviditet for Bolag B AB now; ask only if data is missing.' })
  })

  it('stays not found, with a hint, when the user is not a member of the owning company', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(null)
    vi.mocked(resolveMcpCompanyContext).mockRejectedValue(codedError('NOT_FOUND', 'Company not found'))
    const run = getAccountingTask({ kind: `agent:own/${OWN}` }, 'company-a', db({ company_skills: { company_id: 'company-z' } }) as never, { userId: 'user-1' })
    await expect(run).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('pass that company\'s company_id') })
    expect(loadAgentBundle).toHaveBeenCalledTimes(1)
  })

  it('says so when the user\'s seat in the owning company is paused', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(null)
    vi.mocked(resolveMcpCompanyContext).mockRejectedValue(codedError('FORBIDDEN', 'This company is paused for your account'))
    await expect(getAccountingTask({ kind: `agent:own/${OWN}` }, 'company-a', db({ company_skills: { company_id: 'company-b' } }) as never, { userId: 'user-1' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('does not look elsewhere for a team item, an item of this company or a caller without a user', async () => {
    vi.mocked(loadAgentBundle).mockResolvedValue(null)
    for (const [row, caller] of [[{ company_id: null }, { userId: 'user-1' }], [{ company_id: 'company-a' }, { userId: 'user-1' }], [{ company_id: 'company-b' }, {}]] as const) {
      await expect(getAccountingTask({ kind: `agent:own/${OWN}` }, 'company-a', db({ company_skills: row }) as never, caller)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    expect(resolveMcpCompanyContext).not.toHaveBeenCalled()
  })
})

describe('get_task: which client the run is built for', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadAgentBundle).mockResolvedValue(bundle({ agent: { id: 'kvittojakten', name: 'Kvittojakten' } }))
  })

  it('defaults a missing client to the one the OAuth key was minted for, and says so', async () => {
    const supabase = db({ api_keys: { client: 'chatgpt' } })
    const task = await getAccountingTask({ kind: 'agent:kvittojakten' }, 'company-a', supabase as never, { userId: 'user-1', apiKeyId: 'key-1' }) as AgentTask
    expect(loadAgentBundle).toHaveBeenCalledWith(supabase, 'company-a', 'kvittojakten', 'chatgpt')
    expect(task.built_for_client).toBe('chatgpt')
    expect(supabase.calls).toContainEqual({ table: 'api_keys', method: 'eq', args: ['id', 'key-1'] })
    expect(supabase.calls).toContainEqual({ table: 'api_keys', method: 'eq', args: ['user_id', 'user-1'] })
  })

  it('keeps an explicit client without reading the key', async () => {
    const supabase = db({ api_keys: { client: 'chatgpt' } })
    const task = await getAccountingTask({ kind: 'agent:kvittojakten', client: 'grok' }, 'company-a', supabase as never, { userId: 'user-1', apiKeyId: 'key-1' }) as AgentTask
    expect(task.built_for_client).toBe('grok')
    expect(supabase.calls.some((c) => c.table === 'api_keys')).toBe(false)
  })

  it('falls back to Claude for a key with no known client', async () => {
    for (const stored of [{ client: 'cursor' }, { client: null }, null]) {
      const task = await getAccountingTask({ kind: 'agent:kvittojakten' }, 'company-a', db({ api_keys: stored }) as never, { userId: 'user-1', apiKeyId: 'key-1' }) as AgentTask
      expect(task.built_for_client).toBe('claude')
    }
    const anonymous = await getAccountingTask({ kind: 'agent:kvittojakten' }, 'company-a', db() as never) as AgentTask
    expect(anonymous.built_for_client).toBe('claude')
  })
})
