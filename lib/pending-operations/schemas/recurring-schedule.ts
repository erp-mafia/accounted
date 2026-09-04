import { z } from 'zod'
import {
  CreateRecurringScheduleSchema,
  UpdateRecurringScheduleSchema,
} from '@/lib/api/schemas'

/**
 * Staged-operation params for create_recurring_schedule /
 * update_recurring_schedule. Both the MCP staging tool and the commit
 * executor validate against these, so a tampered pending_operations row is
 * rejected at the commit boundary with the same rules the staging tool
 * enforced (mirrors UpdateCustomerParamsSchema).
 *
 * The field rules live in lib/api/schemas.ts (shared with the cookie-session
 * routes); this module only adds the staged-params envelope.
 */

export const CreateRecurringScheduleParamsSchema = CreateRecurringScheduleSchema.strict()

const RecurringScheduleChangesSchema = UpdateRecurringScheduleSchema
  .strict()
  .superRefine((changes, ctx) => {
    if (Object.keys(changes).length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one schedule field must be supplied',
      })
    }
  })

export const UpdateRecurringScheduleParamsSchema = z
  .object({
    schedule_id: z.string().uuid(),
    changes: RecurringScheduleChangesSchema,
  })
  .strict()
