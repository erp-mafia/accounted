import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getAiService, getAiStatus } from '@/lib/ai'

ensureInitialized()

/**
 * AI fallback for the expense template chooser: the keyword matcher covers
 * known merchants, this ranks the caller-supplied candidate templates for
 * descriptions the keyword lists have never seen. The client only calls it
 * when the local matcher returns nothing, and an empty result is a valid
 * answer, never an error.
 */
const SuggestTemplateSchema = z.object({
  description: z.string().trim().min(2).max(300),
  amount: z.number().nonnegative().optional(),
  candidates: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80),
        name: z.string().trim().min(1).max(120),
        hint: z.string().trim().max(240).optional().nullable(),
      }),
    )
    .min(1)
    .max(80),
})

export const POST = withRouteContext(
  'expense_claims.suggest_template',
  async (request, { log }) => {
    const validation = await validateBody(request, SuggestTemplateSchema)
    if (!validation.success) return validation.response

    const { description, amount, candidates } = validation.data
    if (!getAiStatus().configured) {
      return NextResponse.json({ data: { template_ids: [] } })
    }

    try {
      const catalog = candidates
        .map((c) => `${c.id} | ${c.name}${c.hint ? ` | ${c.hint}` : ''}`)
        .join('\n')
      const result = await getAiService().generateStructured({
        tier: 'extraction',
        system:
          'You classify Swedish business expenses onto booking templates. ' +
          'Pick the best matching template ids for the expense, most likely first. ' +
          'Only return ids from the provided catalog. Return at most 3; return none if nothing fits.',
        prompt: `Expense description: ${description}\nAmount (SEK-equivalent): ${amount ?? 'unknown'}\n\nTemplate catalog (id | name | hint):\n${catalog}`,
        maxTokens: 300,
        schema: {
          name: 'template_suggestions',
          jsonSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['template_ids'],
            properties: {
              template_ids: { type: 'array', maxItems: 3, items: { type: 'string' } },
            },
          },
        },
      })
      const parsed = result.value as { template_ids?: unknown } | null
      const known = new Set(candidates.map((c) => c.id))
      const ids = Array.isArray(parsed?.template_ids)
        ? parsed.template_ids.filter((id): id is string => typeof id === 'string' && known.has(id)).slice(0, 3)
        : []
      return NextResponse.json({ data: { template_ids: ids } })
    } catch (err) {
      // A suggestion is decoration: degrade to none instead of failing the UI.
      log.warn('template suggestion failed', { error: err instanceof Error ? err.message : String(err) })
      return NextResponse.json({ data: { template_ids: [] } })
    }
  },
)
