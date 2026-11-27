import { z } from 'zod'
import { accountNumberSchema } from '@/lib/invariants/zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { spendSettingsPatchSchema } from './settings'

/** Request contracts of the dashboard's spend routes (the operations declare their own, the same rules). */

// A real calendar date: a typed 2026-13-45 is a 400 here, not a database error.
const isoDate = saneIsoDateSchema

export const SpendConnectBodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
})

export const SpendConnectKeyBodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  api_key: z.string().trim().min(8).max(512),
})

export const SpendSettingsBodySchema = z.object({ settings: spendSettingsPatchSchema })

export const SpendItemsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['ready', 'review', 'rejected', 'no_entry', 'booked']).optional(),
  connection_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export const SpendBookBodySchema = z.object({
  expected_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  acknowledge_review: z.boolean().optional(),
  debit_account: accountNumberSchema.optional(),
})

export const SpendBookManyBodySchema = z.object({
  item_ids: z.array(z.string().uuid()).min(1).max(50),
})

export const SpendFetchBodySchema = z.object({
  connection_id: z.string().uuid().optional(),
})
