import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createSigningRequest, listSigningRequests } from '@/lib/signing/requests'
import {
  SIGNING_MAX_SIGNERS,
  SIGNING_MAX_TTL_DAYS,
  SIGNING_MESSAGE_MAX,
  SIGNING_NAME_MAX,
  SIGNING_ROLE_MAX,
  SIGNING_TITLE_MAX,
} from '@/lib/signing/types'

const ListQuery = z.object({
  document_id: z.string().uuid().optional(),
  annual_report_version_id: z.string().uuid().optional(),
  status: z.enum(['open', 'completed', 'declined', 'cancelled']).optional(),
})

/**
 * GET /api/signing-requests: the company's signing requests, newest first
 * (?document_id, ?annual_report_version_id for the board's signatures on one
 * locked årsredovisning version, ?status).
 */
export const GET = withRouteContext('signing_requests.list', async (request, { supabase, companyId }) => {
  const url = new URL(request.url)
  const parsed = ListQuery.safeParse({
    document_id: url.searchParams.get('document_id') ?? undefined,
    annual_report_version_id: url.searchParams.get('annual_report_version_id') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
  })
  const query: z.infer<typeof ListQuery> = parsed.success ? parsed.data : {}
  const data = await listSigningRequests(
    { supabase, companyId },
    {
      documentId: query.document_id,
      status: query.status,
      ...(query.annual_report_version_id ? { annualReportVersionId: query.annual_report_version_id } : {}),
    },
  )
  return NextResponse.json({ data })
})

const CreateSchema = z
  .object({
    document_id: z.string().uuid(),
    title: z.string().trim().min(1).max(SIGNING_TITLE_MAX),
    message: z.string().max(SIGNING_MESSAGE_MAX).nullish(),
    expires_in_days: z.number().int().min(1).max(SIGNING_MAX_TTL_DAYS).nullish(),
    send_email: z.boolean().optional(),
    signers: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(SIGNING_NAME_MAX),
            email: z.string().trim().email().max(254).nullish(),
            role_label: z.string().trim().max(SIGNING_ROLE_MAX).nullish(),
            user_id: z.string().uuid().nullish(),
            // The app's dialog only: locks the signer to this person. Never on the v1 or MCP doors.
            personal_number: z.string().max(20).nullish(),
          })
          .strict(),
      )
      .min(1)
      .max(SIGNING_MAX_SIGNERS),
  })
  .strict()

/**
 * POST /api/signing-requests: send an archived PDF for BankID signing. Each
 * signer with an address gets a mail with their own link; the answer carries
 * the link only for a signer no mail reached (the URL is the credential).
 */
export const POST = withRouteContext(
  'signing_requests.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateSchema)
    if (!validation.success) return validation.response
    const input = validation.data
    const outcome = await createSigningRequest(
      { supabase, companyId, userId: user.id, log },
      {
        documentId: input.document_id,
        title: input.title,
        message: input.message,
        expiresInDays: input.expires_in_days,
        sendEmail: input.send_email,
        createdVia: 'app',
        signers: input.signers.map((s) => ({
          name: s.name,
          email: s.email,
          roleLabel: s.role_label,
          userId: s.user_id,
          personalNumber: s.personal_number,
        })),
      },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
