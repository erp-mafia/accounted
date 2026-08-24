/**
 * Recommended tool loadouts per workflow, surfaced by gnubok_get_agent_briefing
 * as `recommended_tools`.
 *
 * Why: client harnesses with deferred tool loading (Claude Code ToolSearch,
 * claude.ai connector search) otherwise burn 4-6 round-trips discovering tools
 * cluster by cluster before any work happens. Each loadout names the exact
 * registry tools a workflow needs, ordered by typical call sequence, so a
 * harness that supports batch selection (ToolSearch select:a,b,c) loads the
 * whole cluster in ONE call, and connector agents stop guessing search
 * keywords.
 *
 * Drift protection (same spirit as deriveToolMeta): the loadouts are validated
 * against the real tool registry and the workflow-skill registry via
 * assertRecommendedLoadoutsValid(), called at module init in server.ts right
 * after the tools array is defined. A loadout naming a tool or skill that does
 * not exist fails module load, and therefore every test that imports the
 * server. __tests__/agent-briefing.test.ts additionally pins the check.
 *
 * The list is static per issue #1098: the briefing does not currently query
 * workflow state (unbooked counts, open periods), so gating inclusion on state
 * would mean new reads in the hot bootstrap path. Every loadout is returned
 * for every company; applicability is the agent's judgment call.
 */
import { workflowSkills } from './skills'

export interface WorkflowLoadout {
  /** Stable snake_case workflow key (e.g. "categorize_month"). */
  workflow: string
  /** One-line English description of what the workflow accomplishes. */
  description: string
  /** Workflow-skill slug: pass to gnubok_load_skill for the full playbook. */
  skill: string
  /** Exact registry tool names, ordered by typical call sequence. */
  tools: readonly string[]
}

export const RECOMMENDED_WORKFLOW_LOADOUTS: readonly WorkflowLoadout[] = [
  {
    workflow: 'categorize_month',
    description: 'Categorize and book a month of bank transactions.',
    skill: 'bank-reconciliation',
    tools: [
      'gnubok_list_uncategorized_transactions',
      'gnubok_suggest_categories',
      'gnubok_categorize_transaction',
      'gnubok_match_transaction_to_invoice',
      // For transactions whose affärshändelse is already booked on an existing
      // verifikat: links without creating new bookkeeping. Categorizing such a
      // transaction would double-book it.
      'gnubok_link_transaction_to_journal_entry',
      // Tagging: check the registry before writing dimensions bags on
      // categorize calls (resolve-don't-select needs real codes/names).
      'gnubok_list_dimensions',
      'gnubok_load_skill',
      'gnubok_approve_pending_operation',
    ],
  },
  {
    workflow: 'close_period',
    description: 'Reconcile, document voucher gaps, and lock a fiscal period.',
    skill: 'month-end-close',
    tools: [
      'gnubok_list_fiscal_periods',
      'gnubok_list_uncategorized_transactions',
      'gnubok_get_reconciliation_status',
      // Account-keyed reconciliation: the rows behind the bridge and the
      // staged link (bank accounts and skattekonto alike).
      'gnubok_list_reconciliation_items',
      'gnubok_reconcile_match',
      'gnubok_list_voucher_gaps',
      'gnubok_explain_voucher_gap',
      'gnubok_lock_period',
      'gnubok_approve_pending_operation',
    ],
  },
  {
    workflow: 'invoice_run',
    description: 'Create and send customer invoices.',
    skill: 'invoicing-rules',
    tools: [
      'gnubok_list_customers',
      'gnubok_create_customer',
      'gnubok_list_articles',
      // Tagging: invoices carry default_dimensions + per-item bags; check the
      // registry before setting them on gnubok_create_invoice.
      'gnubok_list_dimensions',
      'gnubok_create_invoice',
      'gnubok_send_invoice',
      'gnubok_mark_invoice_as_sent',
      'gnubok_approve_pending_operation',
    ],
  },
  {
    workflow: 'vat_declaration',
    description: 'Compute, review, and file the VAT declaration.',
    skill: 'quarterly-vat-review',
    tools: [
      'gnubok_get_vat_report',
      'gnubok_vat_close_check',
      'gnubok_get_general_ledger',
      'gnubok_vat_declaration_validate',
      'gnubok_vat_declaration_submit',
      'gnubok_vat_declaration_status',
      'gnubok_approve_pending_operation',
    ],
  },
  {
    workflow: 'payroll_month',
    description: 'Run monthly payroll and generate the AGI.',
    skill: 'payroll-monthly',
    tools: [
      'gnubok_list_employees',
      'gnubok_create_salary_run',
      'gnubok_calculate_salary_run',
      'gnubok_get_salary_run',
      'gnubok_book_salary_run',
      'gnubok_generate_agi',
      'gnubok_approve_pending_operation',
    ],
  },
]

/**
 * Fails fast when a loadout references a tool or workflow skill that does not
 * exist. Called at module init in server.ts (after the tools array is built)
 * so any rename/removal in the registry breaks the build and the test suite
 * immediately instead of shipping a briefing that recommends phantom tools.
 */
export function assertRecommendedLoadoutsValid(knownToolNames: ReadonlySet<string>): void {
  const knownSkillSlugs = new Set(workflowSkills.map((s) => s.slug))
  const seenWorkflows = new Set<string>()
  for (const loadout of RECOMMENDED_WORKFLOW_LOADOUTS) {
    if (seenWorkflows.has(loadout.workflow)) {
      throw new Error(
        `recommended_tools: duplicate workflow key "${loadout.workflow}" in RECOMMENDED_WORKFLOW_LOADOUTS.`
      )
    }
    seenWorkflows.add(loadout.workflow)
    if (!knownSkillSlugs.has(loadout.skill)) {
      throw new Error(
        `recommended_tools: workflow "${loadout.workflow}" references unknown skill slug "${loadout.skill}". ` +
          'Update RECOMMENDED_WORKFLOW_LOADOUTS in recommended-tools.ts.'
      )
    }
    for (const toolName of loadout.tools) {
      if (!knownToolNames.has(toolName)) {
        throw new Error(
          `recommended_tools: workflow "${loadout.workflow}" references unknown tool "${toolName}". ` +
            'Update RECOMMENDED_WORKFLOW_LOADOUTS in recommended-tools.ts when renaming or removing tools.'
        )
      }
    }
  }
}
