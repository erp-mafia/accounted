import { z } from 'zod'

// Atom selection output. The Opus call returns this via tool_use forcing:
// the model is forced to invoke `compose_agent_profile(...)` once, which
// gives us Zod-validatable structured output instead of free-text JSON.
export const AtomSelectionSchema = z.object({
  horizontal_atoms: z
    .array(z.string())
    .describe('Atom IDs of horizontal regulatory skills to load (e.g. "horizontal/swedish-vat").'),
  vertical_atoms: z
    .array(z.string())
    .describe(
      'Atom IDs of industry/vertical atoms (e.g. "vertical/konsult-it"). Empty array if no vertical fits.',
    ),
  modifier_atoms: z
    .array(z.string())
    .describe(
      'Atom IDs of cross-cutting modifier atoms (e.g. "modifier/single-shareholder-ab-fmb").',
    ),
  is_multi_vertical: z
    .boolean()
    .describe('True when the company genuinely spans more than one industry.'),
  verification_questions: z
    .array(z.string())
    .describe(
      'Short Swedish questions the user must confirm during Phase B verification. Highest-leverage uncertainties only.',
    ),
  uncertainty_notes: z
    .array(z.string())
    .describe('Free-form notes the composer wants to surface to a developer reviewing the selection.'),
})

export type AtomSelection = z.infer<typeof AtomSelectionSchema>

// JSON-Schema for the tool_use forcing. Anthropic's API requires the tool
// schema in plain JSON Schema (not Zod). Kept in sync with AtomSelectionSchema
// by convention; the response is re-validated through Zod after parsing.
// Typed as the SDK's InputSchema shape (mutable) so it satisfies the
// Tool.input_schema parameter.
export const ATOM_SELECTION_TOOL_SCHEMA: {
  type: 'object'
  properties: Record<string, unknown>
  required: string[]
  additionalProperties: boolean
} = {
  type: 'object',
  properties: {
    horizontal_atoms: { type: 'array', items: { type: 'string' } },
    vertical_atoms: { type: 'array', items: { type: 'string' } },
    modifier_atoms: { type: 'array', items: { type: 'string' } },
    is_multi_vertical: { type: 'boolean' },
    verification_questions: { type: 'array', items: { type: 'string' } },
    uncertainty_notes: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'horizontal_atoms',
    'vertical_atoms',
    'modifier_atoms',
    'is_multi_vertical',
    'verification_questions',
    'uncertainty_notes',
  ],
  additionalProperties: false,
}

// Source signals snapshot. Persisted in agent_profiles.source_signals so the
// selection is reconstructable later even if upstream data (TIC, SIE) changes.
export const SourceSignalsSchema = z.object({
  tic: z.record(z.string(), z.unknown()).nullable(),
  sie_summary: z
    .object({
      top_accounts: z.array(z.object({ account: z.string(), abs_amount: z.number() })),
      top_counterparties: z.array(z.object({ name: z.string(), abs_amount: z.number() })),
      year_count: z.number(),
    })
    .nullable(),
  banking_summary: z
    .object({
      top_counterparties: z.array(z.object({ name: z.string(), abs_amount: z.number() })),
      monthly_volume: z.number().nullable(),
    })
    .nullable(),
  atom_registry_version: z.number(),
})

export type SourceSignals = z.infer<typeof SourceSignalsSchema>

// Output of the full composer pipeline.
export interface ComposedProfile {
  companyId: string
  horizontalAtoms: string[]
  verticalAtoms: string[]
  modifierAtoms: string[]
  isMultiVertical: boolean
  verificationQuestions: string[]
  uncertaintyNotes: string[]
  profileSummary: string
  sourceSignals: SourceSignals
  composerModel: string
  composedAt: string
}
