import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { verifyIntegrity } from '@/lib/core/documents/document-service'

ensureInitialized()

/**
 * POST /api/documents/:id/verify
 * Verify document integrity by re-computing SHA-256 and comparing
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.verify',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    try {
      const result = await verifyIntegrity(supabase, companyId, id)

      return NextResponse.json({ data: result })
    } catch (error) {
      console.error('[documents/verify/POST] Verification failed:', error)
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Verification failed' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true }
)
