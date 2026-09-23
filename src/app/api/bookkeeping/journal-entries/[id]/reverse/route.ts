import { NextResponse } from 'next/server'
import { z } from 'zod'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

const ReverseJournalEntrySchema = z
  .object({
    allow_deep_chain: z.boolean().optional(),
  })
  .strict()

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.reverse',
  async (request, { supabase, companyId, user }, { params }) => {
    const { id } = await params
    // Body is optional (existing callers POST with none): the only accepted
    // field is the chain-depth guard override from the "Återför ändå" confirm.
    // An empty body is the supported no-body case; malformed JSON or a
    // non-boolean field is a caller bug and gets a 400 instead of silently
    // reversing without the override the caller thought they sent.
    let allowDeepChain = false
    const rawText = await request.text()
    if (rawText.trim()) {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(rawText)
      } catch {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Ogiltig JSON i förfrågan.',
              message_en: 'Body is not valid JSON.',
            },
          },
          { status: 400 },
        )
      }
      const parsed = ReverseJournalEntrySchema.safeParse(parsedJson)
      if (!parsed.success) {
        return NextResponse.json(
          {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Ogiltigt fält i förfrågan.',
              message_en: 'Invalid request body.',
              details: {
                issues: parsed.error.issues.map((i) => ({
                  field: i.path.join('.'),
                  message: i.message,
                })),
              },
            },
          },
          { status: 400 },
        )
      }
      allowDeepChain = parsed.data.allow_deep_chain === true
    }
    const reversalEntry = await reverseEntry(supabase, companyId, user.id, id, undefined, {
      allowDeepChain,
    })
    return NextResponse.json({ data: reversalEntry })
  },
  { requireWrite: true },
)
