/**
 * The signer's route bodies, shared by the token door (/api/signera/[token])
 * and the member door (/api/signing/me/[signerId]) so both answer the same.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { contentDisposition } from '@/lib/api/content-disposition'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { cancelSignatureSession, declineSignature, describeForSigner, pollSignature, startSignature } from './ceremony'
import type { SignerRouteContext } from './route'
import { SIGNING_DECLINE_REASON_MAX } from './types'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** The signer's IP as the proxy forwarded it; BankID requires one. */
export function endUserIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || '127.0.0.1'
}

export async function respondDescribe(_request: Request, { scope }: SignerRouteContext): Promise<Response> {
  return NextResponse.json({ data: await describeForSigner(scope) }, { headers: NO_STORE })
}

/**
 * The PDF being signed, inline, only the request's own document. With
 * ?copy=signed, once everyone has signed, the signed copy instead (the one
 * every signer was mailed); never the evidence package.
 */
export async function respondDocument(request: Request, { scope, log, requestId }: SignerRouteContext): Promise<Response> {
  const { service, request: signing } = scope
  const wantsSignedCopy = new URL(request.url).searchParams.get('copy') === 'signed'
  if (wantsSignedCopy && !(signing.status === 'completed' && signing.signed_document_id)) {
    return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'signed copy not sealed' })
  }
  const documentId = wantsSignedCopy ? signing.signed_document_id! : signing.document_id
  const { data: doc } = await service
    .from('document_attachments')
    .select('file_name, storage_path')
    .eq('company_id', signing.company_id)
    .eq('id', documentId)
    .maybeSingle()
  const row = doc as { file_name: string; storage_path: string } | null
  if (!row) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'signing document missing' })
  const { data: blob, error } = await service.storage.from('documents').download(row.storage_path)
  if (error || !blob) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'signing document not downloadable' })
  return new NextResponse(blob, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(wantsSignedCopy ? 'attachment' : 'inline', row.file_name),
      ...NO_STORE,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export async function respondStart(request: Request, { scope, log, requestId }: SignerRouteContext): Promise<Response> {
  const outcome = await startSignature(scope, { endUserIp: endUserIp(request), userAgent: request.headers.get('user-agent') })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview }, { headers: NO_STORE })
  return NextResponse.json({ data: outcome.data }, { headers: NO_STORE })
}

export async function respondPoll(_request: Request, { scope, log, requestId }: SignerRouteContext): Promise<Response> {
  const outcome = await pollSignature(scope)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview }, { headers: NO_STORE })
  return NextResponse.json({ data: outcome.data }, { headers: NO_STORE })
}

export async function respondCancel(_request: Request, { scope, log, requestId }: SignerRouteContext): Promise<Response> {
  const outcome = await cancelSignatureSession(scope)
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview }, { headers: NO_STORE })
  return NextResponse.json({ data: outcome.data }, { headers: NO_STORE })
}

const DeclineSchema = z.object({ reason: z.string().max(SIGNING_DECLINE_REASON_MAX).nullish() }).strict()

export async function respondDecline(request: Request, { scope, log, requestId }: SignerRouteContext): Promise<Response> {
  const validation = await validateBody(request, DeclineSchema)
  if (!validation.success) return validation.response
  const outcome = await declineSignature(scope, { reason: validation.data.reason })
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview }, { headers: NO_STORE })
  return NextResponse.json({ data: outcome.data }, { headers: NO_STORE })
}
