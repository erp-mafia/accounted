/**
 * Dimension registry operations (SIE #DIM): the dimension itself, not its
 * values (those are dimensions/:id/values, hand-written routes predating the
 * operation registry). Rules live in lib/dimensions/registry-service.ts.
 */
import { z } from 'zod'
import {
  createDimension,
  deleteDimension,
  listDimensions,
  updateDimension,
} from '@/lib/dimensions/registry-service'
import { defineOperation } from './types'

const DimensionValue = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
})

const Dimension = z.object({
  id: z.string().uuid(),
  sie_dim_no: z.number().int().min(1),
  name: z.string(),
  parent_sie_dim_no: z.number().int().nullable(),
  resets_annually: z.boolean(),
  is_system: z.boolean(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
})

const DIMENSION_ID = z.string().uuid().describe('The dimension row id (from GET /dimensions), not its sie_dim_no.')

export const dimensionsList = defineOperation({
  id: 'dimensions.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List dimensions (kostnadsställe/projekt) with their values.',
    description:
      'Returns the company\'s dimension registry: SIE #DIM entries keyed by sie_dim_no (1 = Kostnadsställe, 6 = Projekt; both always exist): with the registered values (#OBJEKT) nested under each dimension. Dimensions are ordered by sort_order, values by code. Line-level tags on journal entries reference these values as {"<sie_dim_no>":"<code>"} in the `dimensions` map.',
    useWhen:
      'You need the valid dimension value codes before tagging journal-entry lines with a cost centre or project, or you are rendering a dimension picker.',
    doNotUseFor:
      'Filtering reports (pass the dimension filter to the report endpoints once available) or reading which lines carry a tag (read the journal entries themselves).',
    pitfalls: [
      'Dimension value codes are STRINGS and case-sensitive: "P001", not 1.',
      'sie_dim_no is the key used in journal_entry_lines.dimensions, NOT the dimension row id.',
      'is_active=false values are historical (archived): do not tag new lines with them.',
      'resets_annually=true (dim 1) means balances reset each fiscal year; dim 6 (projekt) accumulates across years.',
    ],
    example: {
      response: {
        data: {
          dimensions: [
            {
              id: '0e9c…',
              sie_dim_no: 1,
              name: 'Kostnadsställe',
              parent_sie_dim_no: null,
              resets_annually: true,
              is_system: true,
              is_active: true,
              sort_order: 10,
              values: [
                { id: 'a8f1…', code: 'BUTIK', name: 'Butiken', is_active: true, start_date: null, end_date: null },
              ],
            },
          ],
        },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: z.object({}),
  output: z.object({ dimensions: z.array(Dimension.extend({ values: z.array(DimensionValue) })) }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/dimensions' },
  run: (ctx) => listDimensions(ctx),
})

export const dimensionsCreate = defineOperation({
  id: 'dimensions.create',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Create a custom dimension (e.g. Avdelning, Kund, Fordon).',
    description:
      'Adds a dimension to the registry (SIE #DIM). Omit sie_dim_no and the next free number from 20 is used: SIE reserves 1-19 for standardized meanings (1 Kostnadsställe, 6 Projekt, 7 Anställd, ...). parent_sie_dim_no declares an #UNDERDIM hierarchy and must name an existing dimension. Add values afterwards with POST /dimensions/{id}/values. Idempotent. Dry-runnable.',
    useWhen:
      'The company wants to follow up on something beyond kostnadsställe and projekt, and no existing dimension fits.',
    doNotUseFor:
      'Adding a cost centre or project code: those are values of the system dimensions 1 and 6 (POST /dimensions/{id}/values).',
    pitfalls: [
      'An explicit sie_dim_no that is taken returns 409 DIMENSION_NUMBER_TAKEN; omit it to get the next free number.',
      'Numbers 1-19 have standardized SIE meanings: only use one when the dimension really is that (e.g. 7 Anställd).',
      'resets_annually defaults to true (balances reset each fiscal year, like kostnadsställe); set false for things that accumulate, like projekt.',
    ],
    example: {
      request: { name: 'Avdelning' },
      response: {
        data: {
          dimension: {
            id: '3c1d…',
            sie_dim_no: 20,
            name: 'Avdelning',
            parent_sie_dim_no: null,
            resets_annually: true,
            is_system: false,
            is_active: true,
            sort_order: 100,
          },
        },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: z.object({
    name: z.string().trim().min(1).max(60).describe('Display name, e.g. "Avdelning".'),
    sie_dim_no: z.number().int().min(1).max(9999).optional().describe('SIE dimension number. Omit for the next free number from 20.'),
    resets_annually: z.boolean().optional().describe('Whether balances reset each fiscal year. Default true.'),
    parent_sie_dim_no: z.number().int().min(1).max(9999).nullable().optional().describe('Parent dimension number (#UNDERDIM).'),
  }),
  output: z.object({ dimension: Dimension }),
  errorCodes: ['DIMENSION_NUMBER_TAKEN', 'DIMENSION_PARENT_INVALID'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/dimensions' },
  mcp: {
    name: 'gnubok_create_dimension',
    title: 'Create Dimension',
    description:
      'Stage a new custom dimension (SIE #DIM) beside kostnadsställe (1) and projekt (6), e.g. Avdelning. Omit sie_dim_no for the next free number from 20. Add values with gnubok_create_dimension_value after approval.',
    keywords: ['ny dimension', 'skapa dimension', 'avdelning', 'underdimension', 'resultatenhet'],
    stage: { pendingType: 'create_dimension', title: (input) => `Ny dimension: ${String(input.name)}` },
  },
  run: (ctx, input, { dryRun }) => createDimension(ctx, input, { dryRun }),
})

export const dimensionsUpdate = defineOperation({
  id: 'dimensions.update',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Rename, archive or reorder a dimension.',
    description:
      'Sparse update of a dimension: name, is_active (false archives it, hiding it from pickers while history keeps its tags) and sort_order. The system dimensions 1 (Kostnadsställe) and 6 (Projekt) can be archived and reordered but not renamed. sie_dim_no is immutable. Idempotent. Dry-runnable.',
    useWhen: 'A dimension needs a clearer name, should stop being offered for new tags, or should move in the pickers.',
    doNotUseFor: 'Changing a value (use PATCH /dimensions/{id}/values/{valueId}) or removing a dimension (DELETE).',
    pitfalls: [
      'Renaming a system dimension returns 400 DIMENSION_SYSTEM_RENAME.',
      'At least one of name, is_active, sort_order must be sent.',
    ],
    example: {
      request: { is_active: false },
      response: {
        data: {
          id: '3c1d…',
          sie_dim_no: 20,
          name: 'Avdelning',
          parent_sie_dim_no: null,
          resets_annually: true,
          is_system: false,
          is_active: false,
          sort_order: 100,
        },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: z
    .object({
      dimension_id: DIMENSION_ID,
      name: z.string().min(1).max(80).optional(),
      is_active: z.boolean().optional().describe('false archives the dimension.'),
      sort_order: z.number().int().min(0).optional(),
    })
    .refine((b) => b.name !== undefined || b.is_active !== undefined || b.sort_order !== undefined, {
      message: 'Send at least one of name, is_active, sort_order.',
    }),
  output: Dimension,
  errorCodes: ['DIMENSION_NOT_FOUND', 'DIMENSION_SYSTEM_RENAME'],
  http: {
    method: 'PATCH',
    path: '/api/v1/companies/:companyId/dimensions/:id',
    pathParams: { id: 'dimension_id' },
  },
  mcp: {
    name: 'gnubok_update_dimension',
    title: 'Update Dimension',
    description:
      'Stage a rename, archive (is_active=false) or reorder of a dimension. System dimensions 1 and 6 cannot be renamed.',
    keywords: ['byt namn dimension', 'arkivera dimension', 'dölj dimension'],
    stage: { pendingType: 'update_dimension', title: () => 'Ändra dimension' },
  },
  run: (ctx, { dimension_id, ...changes }, { dryRun }) => updateDimension(ctx, dimension_id, changes, { dryRun }),
})

export const dimensionsDelete = defineOperation({
  id: 'dimensions.delete',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Delete a custom dimension nobody has booked on.',
    description:
      'Removes a custom dimension and its values. Refused for the system dimensions and for any dimension whose number is tagged on a posted or reversed verifikat line (BFL 7 kap: booked history is never pulled out from under a verifikat). Archive it with PATCH is_active=false instead. Idempotent. Dry-runnable.',
    useWhen: 'A dimension was created by mistake and nothing has been booked on it.',
    doNotUseFor: 'Retiring a dimension that has been used: archive it (PATCH is_active=false).',
    pitfalls: [
      'A dimension used on any posted line returns 409 DIMENSION_REFERENCED naming it.',
      'System dimensions return 400 DIMENSION_SYSTEM_DELETE.',
    ],
    example: {
      response: {
        data: { deleted: true, dimension_id: '3c1d…' },
        meta: { request_id: 'req_…', api_version: '2026-05-12' },
      },
    },
  },
  input: z.object({ dimension_id: DIMENSION_ID }),
  output: z.object({ deleted: z.literal(true), dimension_id: z.string().uuid() }),
  errorCodes: ['DIMENSION_NOT_FOUND', 'DIMENSION_SYSTEM_DELETE', 'DIMENSION_REFERENCED'],
  http: {
    method: 'DELETE',
    path: '/api/v1/companies/:companyId/dimensions/:id',
    pathParams: { id: 'dimension_id' },
  },
  mcp: {
    name: 'gnubok_delete_dimension',
    title: 'Delete Dimension',
    description:
      'Stage deleting a custom dimension that nothing is booked on. Refused for dims 1 and 6 and for any dimension tagged on a posted line: archive it with gnubok_update_dimension instead.',
    keywords: ['ta bort dimension', 'radera dimension'],
    stage: { pendingType: 'delete_dimension', title: () => 'Ta bort dimension' },
  },
  run: (ctx, { dimension_id }, { dryRun }) => deleteDimension(ctx, dimension_id, { dryRun }),
})
