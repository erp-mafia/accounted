import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { deleteDocument } from '@/lib/core/documents/document-service'
import { eventBus } from '@/lib/events'

ensureInitialized()

/**
 * GET /api/documents/:id
 * Fetch document metadata + signed download URL (60 min expiry)
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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

  // Create signed download URL (60 minutes)
  const { data: signedUrl, error: signError } = await supabase.storage
    .from('documents')
    .createSignedUrl(doc.storage_path, 3600)

  if (signError) {
    return NextResponse.json(
      { error: `Failed to create download URL: ${signError.message}` },
      { status: 500 }
    )
  }

  await eventBus.emit({
    type: 'document.accessed',
    payload: {
      document: { id: doc.id, file_name: doc.file_name },
      userId: user.id,
      companyId,
    },
  })

  return NextResponse.json({
    data: {
      ...doc,
      download_url: signedUrl.signedUrl,
    },
  })
}

/**
 * DELETE /api/documents/:id
 * Remove an uploaded document. Only permitted when the document is not yet
 * linked to a journal entry — once linked, it is räkenskapsinformation under
 * BFL 7 kap 2§ and must be retained for 7 years. For linked docs the caller
 * should use POST /api/documents/:id/versions to supersede via a new version.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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
      { error: error instanceof Error ? error.message : 'Failed to delete document' },
      { status: 500 }
    )
  }
}
