import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { posSalesSettingsPatchSchema } from './settings'

/** Request contracts of the dashboard's POS sales routes (the operations declare their own, the same rules). */

// A real calendar date: a typed 2026-13-45 is a 400 here, not a database error.
const isoDate = saneIsoDateSchema

export const PosConnectBodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  venue_ref: z.string().trim().min(1).max(64),
  sync_from: isoDate.optional(),
})

export const PosSettingsBodySchema = z.object({ settings: posSalesSettingsPatchSchema })

export const PosDaysQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['ready', 'needs_review', 'empty', 'booked']).optional(),
  connection_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
})

export const PosBookBodySchema = z.object({
  acknowledge_issues: z.boolean().optional(),
  expected_raw_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
})

export const PosFetchBodySchema = z.object({
  connection_id: z.string().uuid().optional(),
  business_dates: z.array(isoDate).min(1).max(6).optional(),
})
