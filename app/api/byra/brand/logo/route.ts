import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { requireByraBrandAccess } from '@/lib/byra/brand-access'
import { clearBrandCache } from '@/lib/branding/resolve'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES, LOGO_UPLOAD_MAX_MB } from '@/lib/invoices/branding-constants'

/**
 * POST/DELETE /api/byra/brand/logo
 * Byrå self-service brand logo (the ONE brand field byråer edit themselves;
 * domain, app name and colors stay ops-managed, see DECISIONS.md).
 *
 * brands has no write RLS (ops-managed rows), so writes go through the
 * service client behind an explicit owner/admin check on the caller's byrå
 * team: the same authorization idiom as /api/team/members. Files live in
 * the public `logos` bucket under byra/{teamId}/ (company invoice logos use
 * {companyId}/ top-level; the byra/ prefix keeps the namespaces apart).
 *
 * The timestamped filename doubles as a cache-buster; the 60s brand cache
 * in lib/branding/resolve.ts means other lambda instances can serve the old
 * logo_url for up to a minute after a change. clearBrandCache() covers the
 * instance that handled the write.
 */

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']

async function purgeLogoFiles(
  serviceClient: ReturnType<typeof createServiceClient>,
  teamId: string,
): Promise<void> {
  const prefix = `byra/${teamId}`
  const { data: existing } = await serviceClient.storage.from('logos').list(prefix)
  if (existing && existing.length > 0) {
    await serviceClient.storage
      .from('logos')
      .remove(existing.map((f) => `${prefix}/${f.name}`))
  }
}

export async function POST(request: Request) {
  const { user, error } = await requireAuth()
  if (error) return error

  const { teamId, serviceClient, errorResponse } = await requireByraBrandAccess(user.id)
  if (errorResponse) return errorResponse

  const { data: brand } = await serviceClient
    .from('brands')
    .select('id')
    .eq('team_id', teamId)
    .maybeSingle()
  if (!brand) {
    return NextResponse.json({ error: 'Ingen varumärkesprofil är aktiverad ännu.' }, { status: 404 })
  }

  const formData = await request.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'Ingen fil angiven' }, { status: 400 })
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { error: 'Otillåten filtyp. Tillåtna: PNG, JPG, SVG, WebP.' },
      { status: 400 },
    )
  }
  if (file.size > LOGO_UPLOAD_MAX_BYTES) {
    return NextResponse.json(
      { error: `Filen är för stor (max ${LOGO_UPLOAD_MAX_MB} MB).` },
      { status: 400 },
    )
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const mimeToExt: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
  }
  const ext = mimeToExt[file.type] ?? 'png'
  const storagePath = `byra/${teamId}/logo-${Date.now()}.${ext}`

  await purgeLogoFiles(serviceClient, teamId)

  const { error: uploadError } = await serviceClient.storage
    .from('logos')
    .upload(storagePath, buffer, { contentType: file.type, upsert: true })
  if (uploadError) {
    return NextResponse.json(
      { error: `Uppladdning misslyckades: ${getUserErrorMessage(uploadError)}` },
      { status: 500 },
    )
  }

  const { data: urlData } = serviceClient.storage.from('logos').getPublicUrl(storagePath)

  const { error: updateError } = await serviceClient
    .from('brands')
    .update({ logo_url: urlData.publicUrl })
    .eq('team_id', teamId)
  if (updateError) {
    return NextResponse.json({ error: 'Kunde inte uppdatera varumärket.' }, { status: 500 })
  }

  clearBrandCache()
  return NextResponse.json({ data: { logo_url: urlData.publicUrl } })
}

export async function DELETE() {
  const { user, error } = await requireAuth()
  if (error) return error

  const { teamId, serviceClient, errorResponse } = await requireByraBrandAccess(user.id)
  if (errorResponse) return errorResponse

  const { data: brand } = await serviceClient
    .from('brands')
    .select('id, logo_url')
    .eq('team_id', teamId)
    .maybeSingle()
  if (!brand) {
    return NextResponse.json({ error: 'Ingen varumärkesprofil är aktiverad ännu.' }, { status: 404 })
  }

  await purgeLogoFiles(serviceClient, teamId)

  const { error: updateError } = await serviceClient
    .from('brands')
    .update({ logo_url: null })
    .eq('team_id', teamId)
  if (updateError) {
    return NextResponse.json({ error: 'Kunde inte uppdatera varumärket.' }, { status: 500 })
  }

  clearBrandCache()
  return NextResponse.json({ data: { logo_url: null } })
}
