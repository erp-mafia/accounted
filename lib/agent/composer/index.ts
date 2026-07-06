import type { SupabaseClient } from '@supabase/supabase-js'
import { gatherComposerInputs, inputsToSourceSignals } from './inputs'
import { selectAtoms } from './atom-selection'
import { writeNarrative } from './narrative'
import { preWarmAtomCache } from './prewarm'
import { OPUS_MODEL } from './client'
import type { ComposedProfile } from './schemas'

interface ComposeOptions {
  // When true, runs the selection + narrative + pre-warm but does not write
  // to agent_profiles. Useful for evaluating composer output before commit.
  dryRun?: boolean
  // When true, skips cache pre-warm. Tests and CI typically set this.
  skipPrewarm?: boolean
}

// Top-level composer: gather inputs → select atoms (Opus) → write narrative
// (Sonnet) → persist agent_profiles row → fire-and-forget cache pre-warm.
//
// See dev_docs/specialized-agent-plan.md §6.
export async function composeAgentProfile(
  supabase: SupabaseClient,
  companyId: string,
  options: ComposeOptions = {},
): Promise<ComposedProfile> {
  const inputs = await gatherComposerInputs(supabase, companyId)

  const selection = await selectAtoms(inputs)
  const profileSummary = await writeNarrative(inputs, selection)

  const sourceSignals = inputsToSourceSignals(inputs)
  const composedAt = new Date().toISOString()
  const composerModel = OPUS_MODEL

  if (!options.dryRun) {
    const { error } = await supabase
      .from('agent_profiles')
      .upsert(
        {
          company_id: companyId,
          horizontal_atoms: selection.horizontal_atoms,
          vertical_atoms: selection.vertical_atoms,
          modifier_atoms: selection.modifier_atoms,
          profile_summary: profileSummary,
          source_signals: sourceSignals,
          composed_at: composedAt,
          composer_model: composerModel,
          composer_version: 1,
        },
        { onConflict: 'company_id' },
      )
    if (error) throw new Error(`Failed to upsert agent_profiles: ${error.message}`)
  }

  if (!options.skipPrewarm && !options.dryRun) {
    // Resolve atom body paths from the registry and fire pre-warm.
    const allIds = [
      ...selection.horizontal_atoms,
      ...selection.vertical_atoms,
      ...selection.modifier_atoms,
    ]
    if (allIds.length > 0) {
      const { data: rows } = await supabase
        .from('agent_atom_registry')
        .select('id, body')
        .in('id', allIds)
      const bodies = (rows ?? [])
        .map((r: { body: string | null }) => r.body ?? '')
        .filter((b: string) => b.length > 0)
      // Intentionally not awaited: pre-warm must not block the response.
      void preWarmAtomCache({ atomBodies: bodies })
    }
  }

  return {
    companyId,
    horizontalAtoms: selection.horizontal_atoms,
    verticalAtoms: selection.vertical_atoms,
    modifierAtoms: selection.modifier_atoms,
    isMultiVertical: selection.is_multi_vertical,
    verificationQuestions: selection.verification_questions,
    uncertaintyNotes: selection.uncertainty_notes,
    profileSummary,
    sourceSignals,
    composerModel,
    composedAt,
  }
}

export type { ComposedProfile } from './schemas'
