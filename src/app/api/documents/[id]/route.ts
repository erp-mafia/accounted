import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { deleteDocument } from '@/lib/core/documents/document-service'
import { eventBus } from '@/lib/events'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

/**
 * GET /api/documents/:id
 * Fetch document metadata + signed download URL (60 min expiry)
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.get',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    // Fetch document record
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (docError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // Sign the download URL (60 minutes) and persist the access event in
    // parallel: both depend only on the row fetch and are independent of
    // each other. The emit stays awaited (event-log-handler's insert must
    // not race Vercel function suspension) and never rejects (the bus
    // settles handlers via Promise.allSettled), so it cannot fail this
    // Promise.all.
    //
    // Sign with the service-role client: the storage SELECT policy only
    // covers the uploader's own folder (documents/{uid}/...), while
    // document_attachments rows are company-scoped. Signing with the
    // user-bound client fails for every attachment uploaded by another
    // member of the same company. The row fetch above (RLS + explicit
    // company filter) is the authorization, mirroring the inline proxy
    // route.
    const serviceClient = createServiceClient()
    const [signResult] = await Promise.all([
      serviceClient.storage.from('documents').createSignedUrl(doc.storage_path, 3600),
      eventBus.emit({
        type: 'document.accessed',
        payload: {
          document: { id: doc.id, file_name: doc.file_name },
          userId: user.id,
          companyId,
        },
      }),
    ])
    const { data: signedUrl, error: signError } = signResult

    if (signError) {
      return NextResponse.json(
        { error: `Failed to create download URL: ${getUserErrorMessage(signError)}` },
        { status: 500 }
      )
    }

    return NextResponse.json({
      data: {
        ...doc,
        download_url: signedUrl.signedUrl,
      },
    })
  }
)

/**
 * DELETE /api/documents/:id
 * Remove an uploaded document. Only permitted when the document is not yet
 * linked to a journal entry: once linked, it is räkenskapsinformation under
 * BFL 7 kap 2§ and must be retained for 7 years. For linked docs the caller
 * should use POST /api/documents/:id/versions to supersede via a new version.
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    try {
      const result = await deleteDocument(supabase, companyId, id)

      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: result.status })
      }

      return NextResponse.json({ data: { id: result.document.id, deleted: true } })
    } catch (error) {
      console.error('[documents/DELETE] Failed to delete document:', error)
      return NextResponse.json(
        { error: error instanceof Error ? getUserErrorMessage(error) : 'Failed to delete document' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true }
)
