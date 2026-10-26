import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { voucherStornoBusinessEvent } from '@/lib/bookkeeping/ledger-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import { voucherOwnerOrNull } from '@/lib/core/bookkeeping/voucher-owner'

const ReverseJournalEntrySchema = z
  .object({
    allow_deep_chain: z.boolean().optional(),
  })
  .strict()

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
    // Posting port (step 2i): while POSTING_EVENTS is on, ledger.storno of the
    // verifikat, which the person asked for (user_created), dated the day.
    const reversalEntry = await postingPort.reverseJournalEntry({
      supabase,
      companyId,
      userId: user.id,
      entryId: id,
      options: { allowDeepChain },
      event: () => voucherStornoBusinessEvent({ entryId: id, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns('user_created') }),
      role: 'reversal',
    })
    // The object the verifikat books, if any: a storno leaves it as it was
    // (an invoice stays open), so the answer names it and its own action.
    const ownedBy = await voucherOwnerOrNull(supabase, companyId, { id })
    return NextResponse.json({ data: reversalEntry, owned_by: ownedBy })
  },
  { requireWrite: true },
)
