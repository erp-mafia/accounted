import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES, LOGO_UPLOAD_MAX_MB } from '@/lib/invoices/branding-constants'
import { detectFileMagic } from '@/lib/core/documents/document-service'
import { writeCompanySettings } from '@/lib/company/settings-writer'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * Raster formats only, decided by the file's magic bytes (detectFileMagic),
 * never by the client-declared Content-Type. The logos bucket is PUBLIC and
 * the object is served under the type stored here: an SVG (or an HTML file
 * declared as an image) would be a script-capable document on a public URL,
 * so SVG is not accepted at all and a declared type that disagrees with the
 * bytes is ignored in favour of the bytes.
 */
const LOGO_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const LOGO_TYPE_ERROR = 'Otillåten filtyp. Tillåtna: PNG, JPG, WebP.'

export const POST = withRouteContext(
  'settings.logo.upload',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'Ingen fil angiven' }, { status: 400 })
    }

    if (file.size > LOGO_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: `Filen är för stor (max ${LOGO_UPLOAD_MAX_MB} MB).` }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const detectedType = detectFileMagic(new Uint8Array(buffer))
    const ext = detectedType ? LOGO_TYPE_EXTENSIONS[detectedType] : undefined
    if (!detectedType || !ext) {
      return NextResponse.json({ error: LOGO_TYPE_ERROR }, { status: 400 })
    }
    const storagePath = `${companyId}/logo-${Date.now()}.${ext}`

    const bucket = createServiceClient().storage.from('logos')

    // The files the company has now, gone only once the row points at the new
    // one: a write that did not land keeps the logo it had.
    const { data: existing } = await bucket.list(companyId)

    const { error: uploadError } = await bucket.upload(storagePath, buffer, {
      contentType: detectedType,
      upsert: true,
    })

    if (uploadError) {
      return NextResponse.json({ error: `Uppladdning misslyckades: ${getUserErrorMessage(uploadError)}` }, { status: 500 })
    }

    const { data: urlData } = bucket.getPublicUrl(storagePath)

    const saved = await writeCompanySettings(
      { supabase, companyId, userId: user.id, log },
      { logo_url: urlData.publicUrl },
    )
    if (!saved.ok) {
      await bucket.remove([storagePath])
      return sessionFailureResponse(saved, log, requestId)
    }

    if (existing && existing.length > 0) {
      await bucket.remove(existing.map((f) => `${companyId}/${f.name}`))
    }

    return NextResponse.json({ data: { logo_url: urlData.publicUrl } })
  },
  { requireAdmin: true },
)

export const DELETE = withRouteContext(
  'settings.logo.delete',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    // The row first: a refused write leaves the file its logo_url points at.
    const saved = await writeCompanySettings({ supabase, companyId, userId: user.id, log }, { logo_url: null })
    if (!saved.ok) return sessionFailureResponse(saved, log, requestId)

    const bucket = createServiceClient().storage.from('logos')
    const { data: existing } = await bucket.list(companyId)
    if (existing && existing.length > 0) {
      await bucket.remove(existing.map((f) => `${companyId}/${f.name}`))
    }

    return NextResponse.json({ data: { logo_url: null } })
  },
  { requireAdmin: true },
)
