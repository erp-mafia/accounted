import { describe, it, expect, vi } from 'vitest'
import { usageRow, withAiMeter, withMetering, recordAiUsage, type AiUsageRow } from '../meter'
import type { AiService } from '../types'

const usage = { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: null, cacheReadInputTokens: 800 }

function fakeService(): AiService {
  return {
    provider: 'bedrock',
    capabilities: {} as AiService['capabilities'],
    modelFor: () => 'eu.anthropic.claude-haiku-4-5',
    generateText: vi.fn(async () => ({ text: 'ok', model: 'eu.anthropic.claude-sonnet-5', usage })),
    generateStructured: vi.fn(async () => ({ value: {}, model: 'eu.anthropic.claude-haiku-4-5', usage })),
    extractFromDocument: vi.fn(async () => ({ ok: true as const, text: 't', model: 'eu.anthropic.claude-sonnet-5', usage })),
  }
}

describe('the AI meter: every model call leaves a row with its tokens', () => {
  it('records each call with the label on the request', async () => {
    const rows: AiUsageRow[] = []
    const ai = withMetering(fakeService(), async (r) => { rows.push(r) })
    await ai.generateStructured({ tier: 'cheap', prompt: 'p', maxTokens: 10, schema: { name: 's', jsonSchema: {} }, meter: { feature: 'arkiv_classify', companyId: 'co-1' } })
    expect(rows).toEqual([{ company_id: 'co-1', feature: 'arkiv_classify', tier: 'cheap', model: 'eu.anthropic.claude-haiku-4-5', input_tokens: 1200, output_tokens: 300, cache_read_tokens: 800, cache_write_tokens: 0 }])
  })

  it('takes the label from the surrounding scope when the request has none, and records unlabelled calls too', async () => {
    const rows: AiUsageRow[] = []
    const ai = withMetering(fakeService(), async (r) => { rows.push(r) })
    await withAiMeter({ feature: 'document_read', companyId: 'co-2' }, () => ai.extractFromDocument({ document: { kind: 'text', text: 'x' }, system: 's', instruction: 'i', maxTokens: 10 }))
    await ai.generateText({ tier: 'assistant', prompt: 'p', maxTokens: 10 })
    expect(rows.map((r) => [r.feature, r.company_id, r.tier])).toEqual([['document_read', 'co-2', 'extraction'], ['unlabeled', null, 'assistant']])
  })

  it('does not record a skipped document read, and a failing meter never fails the call', async () => {
    const service = fakeService()
    service.extractFromDocument = vi.fn(async () => ({ ok: false as const, skipped: 'ai_unconfigured' as const }))
    const record = vi.fn(async () => undefined)
    await withMetering(service, record).extractFromDocument({ document: { kind: 'text', text: 'x' }, system: 's', instruction: 'i', maxTokens: 10 })
    expect(record).not.toHaveBeenCalled()
    const failing = { from: () => ({ insert: async () => { throw new Error('down') } }) }
    await expect(recordAiUsage(usageRow(undefined, 'cheap', 'm', usage), failing as never)).resolves.toBeUndefined()
  })
})
