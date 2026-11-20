import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import {
  INVOICE_FONT_UPLOAD_MAX_BYTES,
  INVOICE_FONT_UPLOAD_MAX_MB,
} from '@/lib/invoices/branding-constants'
import {
  detectInvoiceFontFileFormat,
  getInvoiceFontContentType,
} from '@/lib/invoices/font-files'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { writeCompanySettings } from '@/lib/company/settings-writer'
import { sessionFailureResponse } from '@/lib/operations/session'

const ALLOWED_EXTENSIONS = new Set(['ttf', 'woff'])

function safeDisplayName(fileName: string, extension: string): string {
  const baseName = fileName.split(/[\\/]/).pop() ?? `invoice-font.${extension}`
  const cleaned = baseName.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || `invoice-font.${extension}`).slice(0, 200)
}

export const POST = withRouteContext(
  'settings.invoice-font.upload',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Ingen typsnittsfil angiven.' }, { status: 400 })
    }

    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return NextResponse.json(
        { error: 'Otillåten filtyp. Tillåtna format är TTF och WOFF.' },
        { status: 400 },
      )
    }

    if (file.size > INVOICE_FONT_UPLOAD_MAX_BYTES) {
      return NextResponse.json(
        { error: `Filen är för stor (max ${INVOICE_FONT_UPLOAD_MAX_MB} MB).` },
        { status: 400 },
      )
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const format = detectInvoiceFontFileFormat(bytes)
    if (!format || format !== extension) {
      return NextResponse.json(
        { error: 'Filen är inte ett giltigt TTF- eller WOFF-typsnitt.' },
        { status: 400 },
      )
    }

    const fileName = `invoice-font-${Date.now()}.${format}`
    const storagePath = `${companyId}/${fileName}`
    const serviceClient = createServiceClient()
    const bucket = serviceClient.storage.from('invoice-fonts')

    const { error: uploadError } = await bucket.upload(storagePath, bytes, {
      contentType: getInvoiceFontContentType(format),
      upsert: false,
    })
    if (uploadError) {
      return NextResponse.json(
        { error: `Uppladdning misslyckades: ${getUserErrorMessage(uploadError)}` },
        { status: 500 },
      )
    }

    const displayName = safeDisplayName(file.name, format)
    const saved = await writeCompanySettings(
      { supabase, companyId, userId: user.id, log },
      {
        invoice_font_family: 'Custom',
        invoice_custom_font_path: storagePath,
        invoice_custom_font_name: displayName,
      },
    )
    if (!saved.ok) {
      await bucket.remove([storagePath])
      return sessionFailureResponse(saved, log, requestId)
    }

    const { data: existing } = await bucket.list(companyId)
    const obsoletePaths = (existing ?? [])
      .filter((stored) => stored.name !== fileName)
      .map((stored) => `${companyId}/${stored.name}`)
    if (obsoletePaths.length > 0) await bucket.remove(obsoletePaths)

    return NextResponse.json({
      data: {
        invoice_font_family: 'Custom',
        invoice_custom_font_path: storagePath,
        invoice_custom_font_name: displayName,
      },
    })
  },
  { requireAdmin: true },
)

export const DELETE = withRouteContext(
  'settings.invoice-font.delete',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    const saved = await writeCompanySettings(
      { supabase, companyId, userId: user.id, log },
      {
        invoice_font_family: 'Helvetica',
        invoice_custom_font_path: null,
        invoice_custom_font_name: null,
      },
    )
    if (!saved.ok) return sessionFailureResponse(saved, log, requestId)

    const serviceClient = createServiceClient()
    const bucket = serviceClient.storage.from('invoice-fonts')
    const { data: existing } = await bucket.list(companyId)
    if (existing && existing.length > 0) {
      await bucket.remove(existing.map((stored) => `${companyId}/${stored.name}`))
    }

    return NextResponse.json({
      data: {
        invoice_font_family: 'Helvetica',
        invoice_custom_font_path: null,
        invoice_custom_font_name: null,
      },
    })
  },
  { requireAdmin: true },
)
