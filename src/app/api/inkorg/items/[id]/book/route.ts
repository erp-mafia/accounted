import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BookInboxItemOneClickSchema } from '@/lib/api/schemas'
import { bookInkorgItem } from '@/lib/operations/inkorg-book'

/**
 * POST /api/inkorg/items/:id/book
 *
 * The Inkorg's one click: books the plan GET .../booking-plan showed, with
 * no form in between. The plan is computed again from the books as they
 * are now (lib/operations/inkorg-book.ts) and booked only if it is the one
 * the person saw:
 *   - 409 PREVIEW_STALE: the token no longer matches (details carry the
 *     fresh plan and its token); nothing written;
 *   - 409 INBOX_BANK_MATCH_STALE: the bank row the page showed is no longer
 *     the plan's;
 *   - 422 INKORG_BOOKING_NEEDS_ANSWER: the plan still asks (details.ask:
 *     category, seller_country or editor);
 *   - 409 INBOX_ITEM_PAIR_ALREADY_BOOKED: the other half of the purchase is
 *     booked already;
 *   - the engine's own refusals as they are (a locked period among them:
 *     the date is never moved, the page opens the editor).
 * Then the form runs through the shared internals: book-direct, the convert
 * door's registration, or register-and-settle. 200 { data: { form,
 * journal_entry_id, voucher, supplier_created, ... } }.
 *
 * Body: { preview_token, purchase_category?, seller_country?, transaction_id? }.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inkorg.book',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, BookInboxItemOneClickSchema, { log, operation: 'inkorg.book' })
    if (!validation.success) return validation.response

    const outcome = await bookInkorgItem({ supabase, companyId, userId: user.id, log, requestId }, id, validation.data)
    if (!outcome.ok) return outcome.response
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
