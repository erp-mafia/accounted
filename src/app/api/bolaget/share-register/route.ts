import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadRegisterParties } from '@/lib/bolaget/people'
import { loadRoles } from '@/lib/bolaget/roles'
import { bolagetGateResponse, callerIsCompanyAdmin, operationContext } from '@/lib/bolaget/session'
import { loadShareRegisterData } from '@/lib/bolaget/share-register'
import { rolesView, shareEventsView, shareRegisterView } from '@/lib/bolaget/view'
import { readAsOf } from '../as-of'

/**
 * GET /api/bolaget/share-register?as_of=YYYY-MM-DD: the page Aktiebok in one
 * read: the register as of the date, every entry, the roles (for the ABL 8:45
 * flags) and every person and company the registers name, with masked
 * identity. Never a full personnummer.
 *
 * The postal address, e-mail and birth date of the people go to an owner or
 * admin only: they fill in the form that keeps them. A member or viewer reads
 * who holds what, which needs none of the three.
 */
export const GET = withRouteContext('bolaget.share_register', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx, 'registers')
  if (gate) return gate
  const asOf = readAsOf(request)
  if (asOf === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { field: 'as_of' } })
  const op = operationContext(ctx)
  const [data, roles, isAdmin] = await Promise.all([
    loadShareRegisterData(op, asOf ?? null),
    loadRoles(op, asOf ?? null),
    callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId),
  ])
  const people = await loadRegisterParties(ctx.companyId, [...data.parties.keys(), ...roles.roles.map((r) => r.party_id)])
  return NextResponse.json({
    data: {
      register: shareRegisterView(data, roles),
      events: shareEventsView(data),
      roles: rolesView(roles),
      people: [...people.values()]
        .map((person) => (isAdmin ? person : { ...person, address: null, email: null, birth_date: null }))
        .sort((a, b) => a.name.localeCompare(b.name, 'sv')),
      can_print_full_identity: isAdmin,
    },
  })
})
