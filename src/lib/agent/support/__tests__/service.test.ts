import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import sv from '@/messages/sv.json'
import { gateContext, SV_LABELS } from '@/lib/agent/ask/__tests__/ui-fixture'
import type { AiToolDef } from '@/lib/ai'
import type { PageTextIndex } from '../page-text-index'

const generateText = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateText: (...args: unknown[]) => generateText(...args) }),
}))

const ledgerTool: AiToolDef = {
  name: 'gnubok_get_vat_report',
  description: 'VAT report',
  jsonSchema: { type: 'object', properties: {} },
  execute: async () => ({}),
}
const skillTool = (name: string): AiToolDef => ({
  name,
  description: 'Skill reader',
  jsonSchema: { type: 'object', properties: {} },
  execute: async () => ({}),
})
const buildLedgerTools = vi.fn()
vi.mock('@/lib/agent/ask/ledger-tools', async (original) => ({
  ...(await original<typeof import('@/lib/agent/ask/ledger-tools')>()),
  buildLedgerTools: (...args: unknown[]) => buildLedgerTools(...args),
}))
vi.mock('@/lib/agent/ask/snapshot', () => ({
  buildAssistantSnapshot: vi.fn().mockResolvedValue('Moms: kvartal.'),
}))
vi.mock('@/lib/agent/ask/ask-service', () => ({
  companyProfileLine: vi.fn().mockResolvedValue('Företag: Exempelbolaget AB (aktiebolag).'),
}))

const loadNavGateContext = vi.fn()
vi.mock('@/lib/agent/ask/ui-map', async (original) => ({
  ...(await original<typeof import('@/lib/agent/ask/ui-map')>()),
  loadNavGateContext: (...args: unknown[]) => loadNavGateContext(...args),
  loadUiLabels: vi.fn(async () => SV_LABELS),
}))

const loadPageTextIndex = vi.fn()
vi.mock('../page-texts', async (original) => ({
  ...(await original<typeof import('../page-texts')>()),
  loadPageTextIndex: () => loadPageTextIndex(),
  loadMessageTree: vi.fn(async () => sv),
}))

import { answerSupportQuestion } from '../service'
import { supportSystemPrompt } from '../prompt'
import { EmptyModelAnswerError } from '@/lib/agent/ask/errors'
import { LEDGER_READ_TOOLS } from '@/lib/agent/ask/ledger-tools'

const supabase = {} as SupabaseClient
const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INDEX: PageTextIndex = {
  files: ['app/(dashboard)/invoices/page.tsx'],
  keys: [['nav.help']],
  routes: { '/invoices': [0] },
}

const ask = (over: Partial<Parameters<typeof answerSupportQuestion>[0]> = {}) =>
  answerSupportQuestion({
    supabase,
    companyId: COMPANY,
    userId: 'user-1',
    conversationId: 'conv-1',
    question: '  Var skapar jag en faktura?  ',
    route: '/invoices',
    locale: 'sv',
    ...over,
  })

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.SUPPORT_ASSISTANT_EFFORT
  generateText.mockResolvedValue({ text: 'Under Fakturor.', model: 'eu.anthropic.claude-sonnet-5', usage: {} })
  buildLedgerTools.mockResolvedValue([ledgerTool, skillTool('gnubok_list_skills'), skillTool('gnubok_load_skill')])
  loadNavGateContext.mockResolvedValue(gateContext())
  loadPageTextIndex.mockReturnValue(INDEX)
})

describe('answerSupportQuestion', () => {
  it('asks the model with the support prompt, its own tools first, cached, at medium effort', async () => {
    const result = await ask()
    expect(result).toEqual({ answer: 'Under Fakturor.', model: 'eu.anthropic.claude-sonnet-5', handoff: null })

    const req = generateText.mock.calls[0][0]
    expect(req.tier).toBe('assistant')
    expect(req.meter).toEqual({ feature: 'support_ask', companyId: COMPANY })
    expect(req.system).toBe(
      supportSystemPrompt({ locale: 'sv', hasLedgerTools: true, hasPageTexts: true, hasSkillTools: true }),
    )
    expect(req.tools.map((t: AiToolDef) => t.name)).toEqual([
      'read_page',
      'find_in_app',
      'offer_human_support',
      'gnubok_get_vat_report',
      'gnubok_list_skills',
      'gnubok_load_skill',
    ])
    expect(req.cachePrompt).toBe(true)
    expect(req.effort).toBe('medium')
    expect(req.maxSteps).toBe(6)
    expect(req.maxTokens).toBe(16_000)
    expect(req.history).toBeUndefined()
    expect(req.onProgress).toBeUndefined()
  })

  it('puts what differs per company and question in the user turn: the company, its standing, its menu, the question', async () => {
    await ask()
    const prompt: string = generateText.mock.calls[0][0].prompt
    expect(prompt.startsWith('Företag: Exempelbolaget AB (aktiebolag).')).toBe(true)
    expect(prompt).toContain('Moms: kvartal.')
    expect(prompt).toContain('Appens meny för det här bolaget')
    expect(prompt).toContain('(/invoices)')
    expect(prompt.endsWith('Fråga: Var skapar jag en faktura?')).toBe(true)
    // Nothing of the company in the part every company shares.
    expect(generateText.mock.calls[0][0].system).not.toContain('Exempelbolaget')
  })

  it('runs the read tools as the asking user in the conversation, for the audit trail: the ledger readers plus the skill readers', async () => {
    await ask()
    const [client, company, user, conversation, names] = buildLedgerTools.mock.calls[0]
    expect([client, company, user, conversation]).toEqual([supabase, COMPANY, 'user-1', 'conv-1'])
    expect(names).toEqual([...LEDGER_READ_TOOLS, 'gnubok_list_skills', 'gnubok_load_skill'])
    // No writer is asked for by name (buildLedgerTools also drops any tool
    // the registry itself marks as writing): not the memory writers the old
    // chat had, not a staging tool.
    for (const writer of ['gnubok_remember_fact', 'gnubok_forget_fact', 'gnubok_create_voucher', 'gnubok_categorize_transaction']) {
      expect(names).not.toContain(writer)
    }
  })

  it('hands on the earlier turns and the progress callback when it has them', async () => {
    const onProgress = vi.fn()
    const history = [
      { role: 'user' as const, text: 'Hej' },
      { role: 'assistant' as const, text: 'Hej!' },
    ]
    await ask({ history, onProgress })
    const req = generateText.mock.calls[0][0]
    expect(req.history).toEqual(history)
    expect(req.onProgress).toBe(onProgress)
  })

  it('reports that the assistant itself offered a person', async () => {
    generateText.mockImplementation(async (req: { tools: AiToolDef[] }) => {
      const offer = req.tools.find((t) => t.name === 'offer_human_support')
      await offer?.execute({ reason: 'account_or_billing', summary: 'Vill byta betalkort.' })
      return { text: 'Det kan supporten hjälpa dig med.', model: 'm', usage: {} }
    })
    const result = await ask()
    expect(result.handoff).toEqual({ reason: 'account_or_billing', summary: 'Vill byta betalkort.' })
  })

  it('works from the menu alone when the build wrote no page texts', async () => {
    loadPageTextIndex.mockReturnValue(null)
    await ask()
    const req = generateText.mock.calls[0][0]
    expect(req.tools.map((t: AiToolDef) => t.name).slice(0, 2)).toEqual(['offer_human_support', 'gnubok_get_vat_report'])
    expect(req.system).toBe(
      supportSystemPrompt({ locale: 'sv', hasLedgerTools: true, hasPageTexts: false, hasSkillTools: true }),
    )
    expect(req.prompt).toContain('Appens meny för det här bolaget')
  })

  it('attaches no page tools when the company menu cannot be resolved: it could not tell which pages the company has', async () => {
    loadNavGateContext.mockResolvedValue(null)
    await ask()
    const req = generateText.mock.calls[0][0]
    expect(req.tools.map((t: AiToolDef) => t.name).slice(0, 2)).toEqual(['offer_human_support', 'gnubok_get_vat_report'])
    expect(req.prompt).not.toContain('Appens meny')
  })

  it('says so in the prompt when the installation has no ledger tools and no skill readers', async () => {
    buildLedgerTools.mockResolvedValue([])
    await ask()
    const req = generateText.mock.calls[0][0]
    expect(req.system).toBe(
      supportSystemPrompt({ locale: 'sv', hasLedgerTools: false, hasPageTexts: true, hasSkillTools: false }),
    )
  })

  it('does not count the skill readers as ledger tools', async () => {
    buildLedgerTools.mockResolvedValue([skillTool('gnubok_list_skills'), skillTool('gnubok_load_skill')])
    await ask()
    const req = generateText.mock.calls[0][0]
    expect(req.system).toBe(
      supportSystemPrompt({ locale: 'sv', hasLedgerTools: false, hasPageTexts: true, hasSkillTools: true }),
    )
  })

  it('sends no effort when the installation asked for the model default', async () => {
    process.env.SUPPORT_ASSISTANT_EFFORT = 'default'
    await ask()
    expect('effort' in generateText.mock.calls[0][0]).toBe(false)
  })

  it('fails typed on an empty answer, never returns one', async () => {
    generateText.mockResolvedValue({ text: '   ', model: 'm', usage: {}, truncated: true })
    await expect(ask()).rejects.toBeInstanceOf(EmptyModelAnswerError)
  })

  it('marks an answer that was cut off', async () => {
    generateText.mockResolvedValue({ text: 'Halvt svar', model: 'm', usage: {}, truncated: true })
    const result = await ask()
    expect(result.answer.startsWith('Halvt svar\n\n')).toBe(true)
    expect(result.answer.length).toBeGreaterThan('Halvt svar\n\n'.length)
  })
})
