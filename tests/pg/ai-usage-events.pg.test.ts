import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany } from './fixtures'

/**
 * ai_usage_events keeps the tokens of every model call, internal only:
 * the service role writes and reads, a company member sees nothing, and
 * ai_cost_daily prices the tokens from ai_model_prices in kronor.
 */
describe('ai_usage_events and ai_cost_daily', () => {
  it('prices a call from the price table: 1M input + 1M output Haiku tokens at 10.5 SEK/USD', async () => {
    const companyId = randomUUID()
    const feature = `test_${randomUUID().slice(0, 8)}`
    await runAsServiceRole((client) =>
      client.query(
        `INSERT INTO public.ai_usage_events (company_id, feature, tier, model, input_tokens, output_tokens)
         VALUES ($1, $2, 'cheap', 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', 1000000, 1000000)`,
        [companyId, feature],
      ),
    )
    const { rows } = await getPool().query<{ calls: string; cost_sek: string }>(`SELECT calls, cost_sek FROM public.ai_cost_daily WHERE feature = $1`, [feature])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].calls)).toBe(1)
    // (1M * $1 + 1M * $5) / 1M * 10.5
    expect(Number(rows[0].cost_sek)).toBe(63)
  })

  it('leaves a call to an unpriced model with its tokens and no cost, never dropped', async () => {
    const feature = `test_${randomUUID().slice(0, 8)}`
    await runAsServiceRole((client) => client.query(`INSERT INTO public.ai_usage_events (feature, model, input_tokens) VALUES ($1, 'some-new-model', 500)`, [feature]))
    const { rows } = await getPool().query<{ input_tokens: string; cost_sek: string | null }>(`SELECT input_tokens, cost_sek FROM public.ai_cost_daily WHERE feature = $1`, [feature])
    expect(rows[0]).toMatchObject({ input_tokens: '500', cost_sek: null })
  })

  it('shows a company member nothing: no read of the events, the prices or the view, and no write', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(withUserContext(userId, (c) => c.query(`SELECT * FROM public.ai_usage_events`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (c) => c.query(`SELECT * FROM public.ai_model_prices`))).rejects.toThrow(/permission denied/)
    await expect(withUserContext(userId, (c) => c.query(`SELECT * FROM public.ai_cost_daily`))).rejects.toThrow(/permission denied/)
    await expect(
      withUserContext(userId, (c) => c.query(`INSERT INTO public.ai_usage_events (company_id, feature, model) VALUES ($1, 'x', 'y')`, [companyId])),
    ).rejects.toThrow(/permission denied/)
  })
})
