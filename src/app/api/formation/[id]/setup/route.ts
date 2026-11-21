import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formationRoute } from '@/lib/formation/route'
import { runFormationSetup } from '@/lib/formation/setup'

/**
 * POST /api/formation/:id/setup: the one approval after registration. Creates
 * the company from the organisation number and sets it up from the
 * formation (lib/formation/setup.ts). Safe to repeat: a retry continues
 * where an earlier run stopped, and a formation already set up answers its
 * company.
 */
const LookupSchema = z
  .object({
    companyName: z.string().max(300),
    isCeased: z.boolean().optional(),
    address: z.object({ street: z.string().max(300), postalCode: z.string().max(20), city: z.string().max(120) }).nullable().optional(),
    registration: z.object({ fTax: z.boolean().nullable().optional(), vat: z.boolean().nullable().optional() }).passthrough().optional(),
    legalEntityType: z.string().max(80).nullable().optional(),
    registrationDate: z.number().nullable().optional(),
  })
  .passthrough()

const SetupSchema = z.object({
  org_number: z.string().min(10).max(13),
  company_name: z.string().trim().min(1).max(200),
  registration_date: saneIsoDateSchema,
  beneficial_owners_confirmed: z.boolean(),
  lookup: LookupSchema.nullable().optional(),
})

export const POST = formationRoute<{ params: Promise<{ id: string }> }>('formation.setup', async (request, { user, supabase, service, log }, { params }) => {
  const { id } = await params
  const validation = await validateBody(request, SetupSchema)
  if (!validation.success) return validation.response
  const body = validation.data
  const result = await runFormationSetup({
    supabase,
    service,
    userId: user.id,
    formationId: id,
    log,
    today: todayIsoStockholm(),
    input: {
      orgNumber: body.org_number,
      companyName: body.company_name,
      registrationDate: body.registration_date,
      beneficialOwnersConfirmed: body.beneficial_owners_confirmed,
      lookup: (body.lookup as never) ?? null,
    },
  })
  return NextResponse.json({ data: { company_id: result.companyId } })
})
