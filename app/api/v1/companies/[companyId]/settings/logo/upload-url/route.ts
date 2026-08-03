import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dataEnvelope, registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { LOGO_ALLOWED_MIME_TYPES } from '@/lib/invoices/branding-constants'
import {
  LOGO_BUCKET,
  SIGNED_LOGO_UPLOAD_TTL_SECONDS,
  createLogoStoragePath,
} from '@/lib/invoices/company-logo'

const Body = z.object({
  mime_type: z.enum(LOGO_ALLOWED_MIME_TYPES),
})

const SignedLogoUploadResponse = z.object({
  upload_url: z.string().url(),
  method: z.literal('PUT'),
  storage_path: z.string(),
  mime_type: z.enum(LOGO_ALLOWED_MIME_TYPES),
  expires_in_seconds: z.number().int(),
  complete_endpoint: z.string(),
})

registerEndpoint({
  operation: 'company_logo.create_upload_url',
  method: 'POST',
  path: '/api/v1/companies/:companyId/settings/logo/upload-url',
  summary: 'Create a signed URL for uploading a company logo.',
  description: `Creates a company-scoped Supabase Storage upload URL valid for ${SIGNED_LOGO_UPLOAD_TTL_SECONDS / 3600} hours. PUT the raw image bytes to upload_url with the requested Content-Type, then call the returned completion endpoint with storage_path to validate and activate the logo.`,
  useWhen:
    'An API or MCP client needs to upload a PNG, JPEG, SVG, or WebP company logo without a browser session.',
  doNotUseFor:
    'Uploading invoice attachments or other documents. Use the documents endpoint for accounting evidence.',
  pitfalls: [
    'The URL expires after two hours and accepts one object path only.',
    'Use PUT with the raw file bytes and set Content-Type to the same mime_type requested here.',
    'Uploading does not activate the logo. Call the completion endpoint after the PUT succeeds.',
    'The completion step rejects objects over 10 MB or whose stored Content-Type does not match the requested path extension.',
  ],
  example: {
    request: { mime_type: 'image/png' },
    response: {
      data: {
        upload_url: 'https://example.supabase.co/storage/v1/object/upload/sign/logos/…?token=…',
        method: 'PUT',
        storage_path: '2efb…/logo-upload-4b8e1d9c-60b9-4f3c-9d2e-712fe79a88bf.png',
        mime_type: 'image/png',
        expires_in_seconds: 7200,
        complete_endpoint: '/api/v1/companies/2efb…/settings/logo/complete',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:write',
  risk: 'low',
  idempotent: false,
  reversible: true,
  dryRunSupported: false,
  request: { body: Body },
  response: {
    success: dataEnvelope(SignedLogoUploadResponse),
    errorCodes: ['VALIDATION_ERROR', 'LOGO_UPLOAD_URL_FAILED'],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'company_logo.create_upload_url',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = Body.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        },
      })
    }

    const storagePath = createLogoStoragePath(ctx.companyId!, parsed.data.mime_type)
    const { data, error } = await ctx.supabase.storage
      .from(LOGO_BUCKET)
      .createSignedUploadUrl(storagePath)

    if (error || !data?.signedUrl) {
      ctx.log.error('Failed to create signed company logo upload URL', error as Error, {
        storagePath,
      })
      return v1ErrorResponseFromCode('LOGO_UPLOAD_URL_FAILED', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    return ok(
      {
        upload_url: data.signedUrl,
        method: 'PUT' as const,
        storage_path: storagePath,
        mime_type: parsed.data.mime_type,
        expires_in_seconds: SIGNED_LOGO_UPLOAD_TTL_SECONDS,
        complete_endpoint: `/api/v1/companies/${ctx.companyId!}/settings/logo/complete`,
      },
      { requestId: ctx.requestId },
    )
  },
)
