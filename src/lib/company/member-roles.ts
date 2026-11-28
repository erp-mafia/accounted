import { z } from 'zod'
import type { CompanyRole } from '@/types'

/**
 * The company roles a person can be given under Inställningar > Användare:
 * by an invitation (POST /api/company/members/invite) or by changing the role
 * of a member or a pending invitation (PATCH /api/company/members/[id] and
 * PATCH /api/company/members/invite/[id]). Never 'owner': the owner role is
 * neither granted nor taken there, and the invitation trigger
 * enforce_company_invitation_role refuses it as well. Listed in the order the
 * role pickers show them.
 */
export const GRANTABLE_COMPANY_ROLES = ['viewer', 'invoicer', 'member', 'admin'] as const satisfies readonly CompanyRole[]

export type GrantableCompanyRole = (typeof GRANTABLE_COMPANY_ROLES)[number]

/** Body of a role change: one of the grantable roles. */
export const CompanyRoleChangeSchema = z.object({
  role: z.enum(GRANTABLE_COMPANY_ROLES),
})
