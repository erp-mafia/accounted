import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/documents/:id/inline
 *
 * Same-origin proxy that streams a document attachment with
 * `Content-Disposition: inline`, allowing it to render inside
 * an <iframe> or <img> tag.
 *
 * Supabase Storage signed URLs return `Content-Disposition: attachment`,
 * which browsers refuse to render inline — that triggers the
 * "Det här innehållet har blockerats" error in journal entry previews.
 *
 * Defense in depth: the user's cookie-bound client authorizes access
 * (RLS + explicit company_id filter) before the service-role client
 * fetches the file from the non-public `documents` bucket.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  const { id } = await params

  // Authorize via the auth-bound client: RLS + explicit company filter
  // through user_company_ids (defense in depth).
  const { data: doc, error: docError } = await supabase
    .from('document_attachments')
    .select('id, company_id, file_name, mime_type, storage_path')
    .eq('id', id)
    .single()

  if (docError || !doc) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Explicit membership check on top of RLS.
  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('company_id', doc.company_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404 })
  }

  // Use the service-role client to read from the non-public bucket.
  const serviceClient = createServiceClient()
  const { data: blob, error: downloadError } = await serviceClient.storage
    .from('documents')
    .download(doc.storage_path)

  if (downloadError || !blob) {
    return NextResponse.json(
      { error: `Failed to download document: ${downloadError?.message ?? 'unknown error'}` },
      { status: 500 }
    )
  }

  const safeFileName = doc.file_name.replace(/[\r\n"]/g, '_')

  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': doc.mime_type ?? 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safeFileName}"`,
      'Cache-Control': 'private, max-age=300',
    },
  })
}
