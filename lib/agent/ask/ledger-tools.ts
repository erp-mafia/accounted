import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiToolDef } from '@/lib/ai'
import { agentToolRegistry } from '@/lib/agent/tools/registry'
import type { AgentActorContext } from '@/lib/agent/tools/types'

/**
 * The read-only tools the single-call assistant may call to answer questions
 * about the ledger (audit Option A: "single-call actions over the existing MCP
 * tool functions"). This is what makes the console behave like an MCP client:
 * the model asks for a report, we run the real tool, feed the JSON back.
 *
 * The list is the read slice of general.help's old tool whitelist: the
 * analytical reports and the lookups across the working set. Write/staging
 * tools (categorize, create_invoice, approve_supplier_invoice, stage_year_end,
 * …) and the memory-write tools (remember/forget) are deliberately absent: the
 * console has no ApprovalCard surface, so it reads and guides only; write
 * actions belong to the page-specific intents where a single entity is in
 * focus and the user expects a staged card.
 *
 * The registry is populated by the mcp-server extension at init
 * (ensureInitialized). In a core-only build it is empty, so this returns an
 * empty list and the assistant answers from the prompt + snapshot alone: the
 * graceful, correct degradation.
 */
export const LEDGER_READ_TOOLS: readonly string[] = [
  // Reports (the canonical analytical surface)
  'gnubok_get_income_statement',
  'gnubok_get_balance_sheet',
  'gnubok_get_trial_balance',
  'gnubok_get_general_ledger',
  'gnubok_get_kpi_report',
  'gnubok_get_vat_report',
  'gnubok_vat_close_check',
  'gnubok_get_ar_ledger',
  'gnubok_get_supplier_ledger',
  'gnubok_get_reconciliation_status',
  'gnubok_get_salary_journal',
  'gnubok_year_end_readiness',
  // Lookups across the working set
  'gnubok_query_journal',
  'gnubok_list_uncategorized_transactions',
  'gnubok_list_transactions_without_documents',
  'gnubok_list_invoices',
  'gnubok_list_customers',
  'gnubok_list_suppliers',
  'gnubok_list_supplier_invoices',
  'gnubok_list_accounts',
  'gnubok_list_fiscal_periods',
  'gnubok_list_employees',
  'gnubok_list_inbox_items',
  'gnubok_list_unmatched_documents',
  'gnubok_list_voucher_gaps',
  'gnubok_explain_voucher_gap',
  'gnubok_get_counterparty_templates',
]

/**
 * Build the read-only tool defs for one company/user, bound to the same actor
 * context the streaming runtime uses (`agent_chat` + the conversation id, for
 * BFL audit). Each def's execute dispatches the real registered tool.
 */
export function buildLedgerTools(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  conversationId?: string,
): AiToolDef[] {
  const actor: AgentActorContext = {
    type: 'agent_chat',
    ...(conversationId ? { id: conversationId } : {}),
  }

  return agentToolRegistry
    .getMany([...LEDGER_READ_TOOLS])
    // Belt-and-suspenders on top of the curated whitelist: never expose a tool
    // the registry itself marks writable or destructive, even if it somehow
    // ended up on the list.
    .filter((t) => t.annotations?.readOnlyHint !== false && t.annotations?.destructiveHint !== true)
    .map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: t.inputSchema,
      execute: (args: Record<string, unknown>) =>
        t.execute(args, companyId, userId, supabase, actor),
    }))
}
