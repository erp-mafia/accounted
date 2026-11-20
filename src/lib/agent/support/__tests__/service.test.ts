import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import sv from '@/messages/sv.json'
import { gateContext, SV_LABELS } from '@/lib/agent/ask/__tests__/ui-fixture'
import type { AiProgressEvent, AiToolDef } from '@/lib/ai'
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
import { todayIsoStockholm } from '@/lib/dates/iso'

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
  })

  it('puts what differs per company and question in the user turn: the company, its standing, its menu, the question', async () => {
    await ask()
    const prompt: string = generateText.mock.calls[0][0].prompt
    expect(prompt.startsWith('Företag: Exempelbolaget AB (aktiebolag).')).toBe(true)
    expect(prompt).toContain(`Dagens datum: ${todayIsoStockholm()}.`)
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
    generateText.mockImplementation(async (req: { onProgress: (event: AiProgressEvent) => void }) => {
      req.onProgress({ type: 'text', delta: 'Jag kollar.' })
      req.onProgress({ type: 'tools', names: ['read_page'] })
      req.onProgress({ type: 'text', delta: 'Under Fakturor.' })
      return { text: 'Under Fakturor.', model: 'm', usage: {} }
    })
    const result = await ask({ history, onProgress })
    expect(generateText.mock.calls[0][0].history).toEqual(history)
    // A remark before a lookup is announced as before: the panel clears it, the answer is the last turn.
    expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
      { type: 'text', delta: 'Jag kollar.' },
      { type: 'tools', names: ['read_page'] },
      { type: 'text', delta: 'Under Fakturor.' },
    ])
    expect(result.answer).toBe('Under Fakturor.')
  })

  describe('an answer written before the assistant offers a person', () => {
    const offerAfter = (before: string, after: string) =>
      generateText.mockImplementation(
        async (req: { tools: AiToolDef[]; onProgress: (event: AiProgressEvent) => void }) => {
          req.onProgress({ type: 'text', delta: before })
          req.onProgress({ type: 'tools', names: ['offer_human_support'] })
          await req.tools.find((t) => t.name === 'offer_human_support')?.execute({ reason: 'cannot_answer', summary: 'Färger.' })
          req.onProgress({ type: 'text', delta: after })
          return { text: after, model: 'm', usage: {} }
        },
      )

    it('is kept, in the answer and on screen: the offer is not announced as a lookup', async () => {
      offerAfter('Loggan byter du under Varumärke.', 'Färgerna kan supporten svara på, med knappen nedan.')
      const onProgress = vi.fn()
      const result = await ask({ onProgress })
      expect(result.answer).toBe('Loggan byter du under Varumärke.\n\nFärgerna kan supporten svara på, med knappen nedan.')
      expect(result.handoff).toEqual({ reason: 'cannot_answer', summary: 'Färger.' })
      expect(onProgress.mock.calls.map(([event]) => event)).toEqual([
        { type: 'text', delta: 'Loggan byter du under Varumärke.' },
        { type: 'text', delta: '\n\n' },
        { type: 'text', delta: 'Färgerna kan supporten svara på, med knappen nedan.' },
      ])
    })

    it('stands alone when it had already pointed to the button: the closing sentence would say it twice', async () => {
      offerAfter(
        'Abonnemanget säger du upp under Abonnemang. Vill du ha hjälp kan du använda knappen "Skicka till supporten" nedan.',
        'Du kan skicka frågan med knappen nedan.',
      )
      const onProgress = vi.fn()
      const result = await ask({ onProgress })
      expect(result.answer).toBe(
        'Abonnemanget säger du upp under Abonnemang. Vill du ha hjälp kan du använda knappen "Skicka till supporten" nedan.',
      )
      // Nothing more reaches the screen after the kept answer.
      expect(onProgress).toHaveBeenCalledTimes(1)
    })

    it('is kept without anyone listening to the stream', async () => {
      offerAfter('Loggan byter du under Varumärke.', 'Skicka resten med knappen nedan.')
      const result = await ask()
      expect(result.answer).toBe('Loggan byter du under Varumärke.\n\nSkicka resten med knappen nedan.')
    })

    it('is not doubled when the turn after the offer writes it again', async () => {
      const body = 'Loggan byter du under Varumärke, i avsnittet Logotyp, och den visas sedan på alla fakturor du skickar.'
      offerAfter(body, `${body} Färgerna kan supporten svara på.`)
      const result = await ask()
      expect(result.answer).toBe(`${body} Färgerna kan supporten svara på.`)
    })

    it('is dropped when a lookup follows the offer: what comes after is written anew', async () => {
      generateText.mockImplementation(async (req: { onProgress: (event: AiProgressEvent) => void }) => {
        req.onProgress({ type: 'text', delta: 'Ett första försök.' })
        req.onProgress({ type: 'tools', names: ['offer_human_support'] })
        req.onProgress({ type: 'tools', names: ['read_page'] })
        req.onProgress({ type: 'text', delta: 'Det riktiga svaret.' })
        return { text: 'Det riktiga svaret.', model: 'm', usage: {} }
      })
      expect((await ask()).answer).toBe('Det riktiga svaret.')
    })

    it('is not kept when the same turn also looks something up: that text was a remark', async () => {
      generateText.mockImplementation(async (req: { onProgress: (event: AiProgressEvent) => void }) => {
        req.onProgress({ type: 'text', delta: 'Jag kollar och kopplar in supporten.' })
        req.onProgress({ type: 'tools', names: ['read_page', 'offer_human_support'] })
        return { text: 'Svaret.', model: 'm', usage: {} }
      })
      const onProgress = vi.fn()
      expect((await ask({ onProgress })).answer).toBe('Svaret.')
      expect(onProgress).toHaveBeenCalledWith({ type: 'tools', names: ['read_page', 'offer_human_support'] })
    })
  })

  it('shows the button when the answer points to it without the offer behind it, by its label or in other words', async () => {
    for (const text of [
      'Skicka frågan med knappen "Skicka till supporten" nedan.',
      'Den frågan kan skickas vidare till supporten via knappen nedan.',
    ]) {
      generateText.mockResolvedValue({ text, model: 'm', usage: {} })
      expect((await ask()).handoff).toEqual({ reason: 'cannot_answer', summary: 'Var skapar jag en faktura?' })
    }
  })

  it('shows no button for an answer that names another button, or support without a button', async () => {
    for (const text of ['Klicka på knappen Ny faktura.', 'Supporten kan inte ändra det. Fakturan krediterar du själv.']) {
      generateText.mockResolvedValue({ text, model: 'm', usage: {} })
      expect((await ask()).handoff).toBeNull()
    }
  })

  it('takes the role marks of the page tools out of the answer', async () => {
    generateText.mockResolvedValue({ text: 'Flikarna är:\n- Alla (flik)\n- Betalda (flik)\nKnappen Ny faktura (knapp) finns också.', model: 'm', usage: {} })
    expect((await ask()).answer).toBe('Flikarna är:\n- Alla\n- Betalda\nKnappen Ny faktura finns också.')
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
