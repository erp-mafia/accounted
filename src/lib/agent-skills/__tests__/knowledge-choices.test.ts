import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import fs from 'node:fs'
import path from 'node:path'
import { agentDefaults, applyKnowledgeChoice, loadKnowledgeOptions, ownKnowledgeId, packFitsForm, PACK_LEGAL_FORMS, TAX_PLANNING_PACK_BY_FORM } from '../knowledge-choices'
import { AGENTS, OWN_AGENT_KNOWLEDGE } from '../agents'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const row = { id: 'own-id', company_id: 'company-a', team_id: null, atom_id: null, name: 'Own', description: 'D', body: 'B', share_status: 'private', draft: false }
beforeEach(() => { vi.clearAllMocks(); reset() })

describe('agentDefaults', () => {
  it('gives a curated agent its declared knowledge', async () => {
    expect(await agentDefaults(supabase as never, 'company-a', 'bookkeep')).toEqual(AGENTS.bookkeep.knowledge)
  })
  it('gives an own agent the accounting law by default', async () => {
    enqueue({ data: { team_id: null } }); enqueue({ data: [row] })
    expect(await agentDefaults(supabase as never, 'company-a', 'own/own-id')).toEqual(OWN_AGENT_KNOWLEDGE)
    expect(OWN_AGENT_KNOWLEDGE).toEqual(['horizontal/swedish-accounting-compliance'])
  })
  it('knows no draft or unknown agent', async () => {
    enqueue({ data: { team_id: null } }); enqueue({ data: [{ ...row, draft: true }] })
    expect(await agentDefaults(supabase as never, 'company-a', 'own/own-id')).toBeNull()
    expect(await agentDefaults(supabase as never, 'company-a', 'nope')).toBeNull()
  })
})

describe('own knowledge', () => {
  const RULES = '00000000-0000-4000-8000-0000000000aa'
  it('lists the company\'s own added knowledge after the packs, never its flows or drafts', async () => {
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: 'horizontal/swedish-vat', tier: 'horizontal', title: 'Moms', description: 'VAT.', version: 3, reviewed_at: null }] })
    enqueue({ data: { team_id: null } })
    enqueue({ data: [
      { ...row, id: RULES, name: 'Våra regler', description: 'Hur vi gör.', kind: 'rules' },
      { ...row, id: 'flow-id', kind: 'workflow' },
      { ...row, id: 'draft-id', kind: 'rules', draft: true },
    ] })
    const options = await loadKnowledgeOptions(supabase as never, 'company-a')
    expect(options.map((o) => [o.id, o.tier])).toEqual([['horizontal/swedish-vat', 'horizontal'], [`own/${RULES}`, 'own']])
    expect(options[1]).toMatchObject({ title: 'Våra regler', summary: 'Hur vi gör.' })
  })

  it('reads own/<uuid> as own knowledge and nothing else', () => {
    expect(ownKnowledgeId(`own/${RULES}`)).toBe(RULES)
    expect(ownKnowledgeId('horizontal/swedish-vat')).toBeNull()
    expect(ownKnowledgeId('own/not-a-uuid')).toBeNull()
  })

  it('adds own knowledge as its own row and takes it away by deleting it', async () => {
    enqueue({ data: null })
    await applyKnowledgeChoice(supabase as never, 'company-a', 'own/flow-id', ['horizontal/swedish-accounting-compliance'], 'add', `own/${RULES}`)
    const upsert = findCall('company_agent_knowledge', 'upsert')!
    expect(upsert[0]).toEqual({ company_id: 'company-a', agent_id: 'own/flow-id', own_skill_id: RULES, included: true })
    expect(upsert[1]).toEqual({ onConflict: 'company_id,agent_id,own_skill_id' })
    reset()
    enqueue({ data: null })
    await applyKnowledgeChoice(supabase as never, 'company-a', 'bookkeep', [], 'remove', `own/${RULES}`)
    expect(findCall('company_agent_knowledge', 'delete')).toBeDefined()
    expect(findCall('company_agent_knowledge', 'upsert')).toBeUndefined()
  })
})

describe('packs by legal form', () => {
  const pack = (id: string, tier: string) => ({ id, tier, title: id, description: 'D.', version: 1, reviewed_at: null })
  const PACKS = [
    pack('horizontal/swedish-vat', 'horizontal'),
    pack('modifier/holding-ab', 'modifier'),
    pack('modifier/mixed-verksamhet', 'modifier'),
    pack('modifier/single-shareholder-ab-fmb', 'modifier'),
    pack('vertical/konsult-it', 'vertical'),
  ]
  const optionsFor = async (entityType: string) => {
    enqueue({ data: { entity_type: entityType } }); enqueue({ data: PACKS }); enqueue({ data: { team_id: null } }); enqueue({ data: [] })
    return (await loadKnowledgeOptions(supabase as never, 'company-a')).map((o) => o.id)
  }

  it('never offers an enskild firma or a förening the aktiebolag-only packs', async () => {
    const expected = ['horizontal/swedish-vat', 'modifier/mixed-verksamhet', 'vertical/konsult-it']
    expect(await optionsFor('enskild_firma')).toEqual(expected)
    reset()
    expect(await optionsFor('ideell_forening')).toEqual(expected)
    expect(findCall('companies', 'select')).toEqual(['entity_type'])
  })

  it('offers an aktiebolag every pack', async () => {
    expect(await optionsFor('aktiebolag')).toEqual(PACKS.map((p) => p.id))
  })

  it('fails instead of guessing when the legal form is unknown', async () => {
    enqueue({ data: { entity_type: 'handelsbolag' } }); enqueue({ data: PACKS }); enqueue({ data: { team_id: null } }); enqueue({ data: [] })
    await expect(loadKnowledgeOptions(supabase as never, 'company-a')).rejects.toThrow(/entity_type/)
  })

  it('treats a pack without a legal-form tag as fitting every form', () => {
    expect(packFitsForm('vertical/bygg-hantverk', 'enskild_firma')).toBe(true)
    expect(packFitsForm('modifier/holding-ab', 'enskild_firma')).toBe(false)
    expect(packFitsForm('modifier/holding-ab', 'aktiebolag')).toBe(true)
  })
})

describe('the tax planning packs by legal form', () => {
  const EF_PACK = 'horizontal/swedish-ef-skatteplanering'
  const AB_PACK = 'horizontal/swedish-tax-planning'
  const pack = (id: string) => ({ id, tier: id.split('/')[0], title: id, description: 'D.', version: 1, reviewed_at: null })
  // The registry's order: by tier, then by id.
  const PACKS = [
    pack('horizontal/swedish-accounting-compliance'),
    pack(EF_PACK),
    pack(AB_PACK),
    pack('horizontal/swedish-vat'),
    pack('modifier/holding-ab'),
    pack('modifier/mixed-verksamhet'),
    pack('modifier/single-shareholder-ab-fmb'),
    pack('vertical/konsult-it'),
  ]
  const ALL = PACKS.map((p) => p.id)
  /** What the company was offered before the two packs were tied to a form: everything but the packs of PACK_LEGAL_FORMS written for another form. */
  const before = (entityType: string) => ALL.filter((id) => !PACK_LEGAL_FORMS[id] || (PACK_LEGAL_FORMS[id] as readonly string[]).includes(entityType))
  const optionsFor = async (entityType: string) => {
    reset()
    enqueue({ data: { entity_type: entityType } }); enqueue({ data: PACKS }); enqueue({ data: { team_id: null } }); enqueue({ data: [] })
    return (await loadKnowledgeOptions(supabase as never, 'company-a')).map((o) => o.id)
  }

  it('offers an aktiebolag the pack written for aktiebolag and not the one for enskild firma', async () => {
    expect(before('aktiebolag')).toEqual(ALL)
    expect(await optionsFor('aktiebolag')).toEqual(ALL.filter((id) => id !== EF_PACK))
  })

  it('offers an enskild firma the pack written for enskild firma and not the one for aktiebolag', async () => {
    const was = ['horizontal/swedish-accounting-compliance', EF_PACK, AB_PACK, 'horizontal/swedish-vat', 'modifier/mixed-verksamhet', 'vertical/konsult-it']
    expect(before('enskild_firma')).toEqual(was)
    expect(await optionsFor('enskild_firma')).toEqual(was.filter((id) => id !== AB_PACK))
  })

  it('offers a form neither text names what it was offered before: both packs', async () => {
    for (const form of ['ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening']) {
      const was = before(form)
      expect(was, form).toEqual(expect.arrayContaining([EF_PACK, AB_PACK]))
      expect(await optionsFor(form), form).toEqual(was)
    }
  })

  it('leaves every other pack as it was for every form', async () => {
    for (const form of ['aktiebolag', 'enskild_firma', 'ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening']) {
      const others = (ids: string[]) => ids.filter((id) => id !== EF_PACK && id !== AB_PACK)
      expect(others(await optionsFor(form)), form).toEqual(others(before(form)))
    }
  })

  it('answers the same pack by pack', () => {
    expect(packFitsForm(EF_PACK, 'enskild_firma')).toBe(true)
    expect(packFitsForm(EF_PACK, 'aktiebolag')).toBe(false)
    expect(packFitsForm(AB_PACK, 'aktiebolag')).toBe(true)
    expect(packFitsForm(AB_PACK, 'enskild_firma')).toBe(false)
    for (const form of ['ideell_forening', 'ekonomisk_forening', 'bostadsrattsforening'] as const) {
      expect(packFitsForm(EF_PACK, form), form).toBe(true)
      expect(packFitsForm(AB_PACK, form), form).toBe(true)
    }
  })

  it('names the two packs by their ids in the registry, each for the form its own text names', () => {
    expect(TAX_PLANNING_PACK_BY_FORM).toEqual({ enskild_firma: EF_PACK, aktiebolag: AB_PACK })
    const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'scripts/.skill-body-manifest.json'), 'utf8')) as Record<string, unknown>
    for (const id of [EF_PACK, AB_PACK]) expect(manifest, id).toHaveProperty([id])
    const text = (slug: string) => fs.readFileSync(path.resolve(process.cwd(), `.claude/skills/${slug}/SKILL.md`), 'utf8')
    // The pack for enskild firma says so, and sends an aktiebolag to the other pack.
    expect(text('swedish-ef-skatteplanering')).toContain('# Swedish Tax Planning for Enskild Firma')
    expect(text('swedish-ef-skatteplanering')).toContain('for AB planning use `swedish-tax-planning`')
    // The pack for aktiebolag says so, and sends an enskild firma to the other pack.
    expect(text('swedish-tax-planning')).toContain('this skill is **AB-only**')
    expect(text('swedish-tax-planning')).toContain('use the sister skill `swedish-ef-skatteplanering`')
  })
})
