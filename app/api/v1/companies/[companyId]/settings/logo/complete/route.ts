import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dataEnvelope, registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { LOGO_UPLOAD_MAX_BYTES, LOGO_UPLOAD_MAX_MB } from '@/lib/invoices/branding-constants'
import {
  LOGO_BUCKET,
  cleanupPreviousCompanyLogos,
  getLogoMimeTypeForUploadPath,
  isLogoMimeType,
} from '@/lib/invoices/company-logo'

const Body = z.object({
  storage_path: z.string().min(1),
})

const CompleteLogoUploadResponse = z.object({
  logo_url: z.string().url(),
  storage_path: z.string(),
})

registerEndpoint({
  operation: 'company_logo.complete_upload',
  method: 'POST',
  path: '/api/v1/companies/:companyId/settings/logo/complete',
  summary: 'Validate and activate an uploaded company logo.',
  description:
    'Validates the company-scoped object created by the signed upload flow, checks its stored size and Content-Type, updates company settings, and then removes superseded logo objects.',
  useWhen:
    'The PUT to a signed logo upload URL succeeded and the new object should become the company logo.',
  doNotUseFor:
    'Creating an upload URL or activating an arbitrary object path. Call the upload-url endpoint first.',
  pitfalls: [
    'storage_path must be returned by this company’s upload-url endpoint.',
    `The stored object must be no larger than ${LOGO_UPLOAD_MAX_MB} MB and its Content-Type must match the path extension.`,
    'The previous logo remains active if validation or the settings update fails.',
  ],
  example: {
    request: {
      storage_path: '2efb…/logo-upload-4b8e1d9c-60b9-4f3c-9d2e-712fe79a88bf.png',
    },
    response: {
      data: {
        logo_url: 'https://example.supabase.co/storage/v1/object/public/logos/2efb…/logo-upload-….png',
        storage_path: '2efb…/logo-upload-4b8e1d9c-60b9-4f3c-9d2e-712fe79a88bf.png',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: Body },
  response: {
    success: dataEnvelope(CompleteLogoUploadResponse),
    errorCodes: [
      'VALIDATION_ERROR',
      'LOGO_UPLOAD_NOT_FOUND',
      'LOGO_UPLOAD_TOO_LARGE',
      'LOGO_UPLOAD_UNSUPPORTED_TYPE',
      'LOGO_SETTINGS_NOT_FOUND',
      'LOGO_ACTIVATION_FAILED',
    ],
  },
})

function storageErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const value = Reflect.get(error, 'statusCode') ?? Reflect.get(error, 'status')
  const numeric = typeof value === 'string' ? Number(value) : value
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'company_logo.complete_upload',
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

    const storagePath = parsed.data.storage_path
    const expectedMimeType = getLogoMimeTypeForUploadPath(ctx.companyId!, storagePath)
    if (!expectedMimeType) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'storage_path', message: 'Invalid company logo upload path.' },
      })
    }

    const logoBucket = ctx.supabase.storage.from(LOGO_BUCKET)
    const { data: objectInfo, error: infoError } = await logoBucket.info(storagePath)
    if (infoError || !objectInfo) {
      if (storageErrorStatus(infoError) === 404) {
        return v1ErrorResponseFromCode('LOGO_UPLOAD_NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
        })
      }
      ctx.log.error('Failed to inspect uploaded company logo', infoError as Error, {
        storagePath,
      })
      return v1ErrorResponseFromCode('LOGO_ACTIVATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'inspect_upload' },
      })
    }

    if (objectInfo.size > LOGO_UPLOAD_MAX_BYTES) {
      return v1ErrorResponseFromCode('LOGO_UPLOAD_TOO_LARGE', ctx.log, {
        requestId: ctx.requestId,
        details: { max_bytes: LOGO_UPLOAD_MAX_BYTES, actual_bytes: objectInfo.size },
      })
    }

    const storedMimeType = objectInfo.contentType?.split(';', 1)[0]?.trim().toLowerCase()
    if (!storedMimeType || !isLogoMimeType(storedMimeType) || storedMimeType !== expectedMimeType) {
      return v1ErrorResponseFromCode('LOGO_UPLOAD_UNSUPPORTED_TYPE', ctx.log, {
        requestId: ctx.requestId,
        details: { expected: expectedMimeType, actual: storedMimeType ?? null },
      })
    }

    const { data: urlData } = logoBucket.getPublicUrl(storagePath)
    const { data: settings, error: updateError } = await ctx.supabase
      .from('company_settings')
      .update({ logo_url: urlData.publicUrl })
      .eq('company_id', ctx.companyId!)
      .select('company_id')
      .maybeSingle()

    if (updateError) {
      ctx.log.error('Failed to activate uploaded company logo', updateError as Error, {
        storagePath,
      })
      return v1ErrorResponseFromCode('LOGO_ACTIVATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'update_settings' },
      })
    }
    if (!settings) {
      return v1ErrorResponseFromCode('LOGO_SETTINGS_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const cleanupError = await cleanupPreviousCompanyLogos(
      logoBucket,
      ctx.companyId!,
      storagePath,
    )
    if (cleanupError) {
      ctx.log.warn('Failed to clean up superseded company logos', cleanupError as Error, {
        storagePath,
      })
    }

    return ok(
      { logo_url: urlData.publicUrl, storage_path: storagePath },
      { requestId: ctx.requestId },
    )
  },
)
