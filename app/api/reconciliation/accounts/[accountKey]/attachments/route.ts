import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import {
  attachUnderlag,
  listAttachments,
  MAX_ATTACHMENT_NOTE_LENGTH,
  ReconciliationAttachmentError,
} from '@/lib/reconciliation/attachments'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { ISO_DATE_RE } from '@/lib/invariants'

/**
 * GET  /api/reconciliation/accounts/{accountKey}/attachments?through_date=
 * POST /api/reconciliation/accounts/{accountKey}/attachments (multipart)
 *
 * The underlag of one account's balansdag: the files the account was
 * reconciled against. GET lists them (?include_removed=1 adds the removed
 * ones with their stamp); POST attaches one file: fields `file`,
 * `through_date` and optional `note`. Policy in lib/reconciliation/attachments.ts.
 */
export const GET = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.attachments.list',
  async (request, { supabase, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    const { searchParams } = new URL(request.url)
    const throughDate = searchParams.get('through_date') ?? ''
    if (!ISO_DATE_RE.test(throughDate)) {
      return NextResponse.json({ error: 'through_date (ÅÅÅÅ-MM-DD) krävs' }, { status: 400 })
    }
    const attachments = await listAttachments(supabase, companyId, accountKey, throughDate, {
      includeRemoved: searchParams.get('include_removed') === '1',
    })
    return NextResponse.json({ data: { attachments } })
  },
)

export const POST = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.attachments.create',
  async (request, { supabase, user, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Ogiltig uppladdning: förväntade multipart/form-data' }, { status: 400 })
    }
    const file = form.get('file')
    const throughDate = String(form.get('through_date') ?? '')
    const noteRaw = form.get('note')
    const note = typeof noteRaw === 'string' ? noteRaw : null
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Ingen fil bifogad' }, { status: 400 })
    }
    if (!ISO_DATE_RE.test(throughDate)) {
      return NextResponse.json({ error: 'through_date (ÅÅÅÅ-MM-DD) krävs' }, { status: 400 })
    }
    if (note && note.length > MAX_ATTACHMENT_NOTE_LENGTH) {
      return NextResponse.json({ error: 'Noteringen är för lång' }, { status: 400 })
    }
    try {
      const attachment = await attachUnderlag(supabase, companyId, user.id, accountKey, {
        through_date: throughDate,
        note,
        file: { name: file.name, type: file.type, size: file.size, buffer: await file.arrayBuffer() },
      })
      return NextResponse.json({ data: { attachment } }, { status: 201 })
    } catch (err) {
      if (err instanceof ReconciliationAttachmentError) {
        return NextResponse.json({ error: getErrorMessage(err), code: err.code }, { status: 400 })
      }
      throw err
    }
  },
  { requireWrite: true },
)
