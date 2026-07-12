import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createNewVersion, validateDocumentFile } from '@/lib/core/documents/document-service'

ensureInitialized()

/**
 * POST /api/documents/:id/versions
 * Create a new version of an existing document (atomic via RPC)
 *
 * Accepts multipart/form-data with:
 * - file: The new version file
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.versions.create',
  async (request, { supabase, user }, { params }) => {
    const { id } = await params

    try {
      const formData = await request.formData()
      const file = formData.get('file') as File | null

      if (!file) {
        return NextResponse.json({ error: 'No file provided' }, { status: 400 })
      }

      const validationError = validateDocumentFile({ size: file.size, type: file.type })
      if (validationError) {
        return NextResponse.json({ error: validationError }, { status: 400 })
      }

      const buffer = await file.arrayBuffer()

      const newVersion = await createNewVersion(supabase, user.id, id, {
        name: file.name,
        buffer,
        type: file.type,
      })

      return NextResponse.json({ data: newVersion })
    } catch (error) {
      console.error('[documents/versions/POST] Version creation failed:', error)
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Version creation failed' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true }
)

/**
 * GET /api/documents/:id/versions
 * List all versions in the document chain
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.versions.list',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // First, check if the document belongs to the company
    const { data: doc, error: docError } = await supabase
      .from('document_attachments')
      .select('id, original_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (docError || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 })
    }

    // The root document is either the original_id or the document itself
    const rootId = doc.original_id || doc.id

    // Fetch all versions in the chain
    const { data: versions, error: versionsError } = await supabase
      .from('document_attachments')
      .select('*')
      .eq('company_id', companyId)
      .or(`id.eq.${rootId},original_id.eq.${rootId}`)
      .order('version', { ascending: true })

    if (versionsError) {
      return NextResponse.json({ error: versionsError.message }, { status: 500 })
    }

    return NextResponse.json({ data: versions })
  }
)
