import { describe, it, expect } from 'vitest'
import { tools, deriveToolMeta } from '../server'

describe('tools/list payload size guard', () => {
  it('keeps the projected tools/list payload under the context-budget ceiling', () => {
    // Mirror the real tools/list serializer, including the derived staging
    // _meta (requires_approval / approve_tool / preflight) merged over any
    // literal _meta — otherwise the guard under-measures the wire payload.
    const projection = tools.map((t) => {
      const meta = { ...(deriveToolMeta(t) ?? {}), ...(t._meta ?? {}) }
      return {
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        annotations: t.annotations,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      }
    })
    const payload = JSON.stringify({ tools: projection })
    const approxTokens = Math.round(payload.length / 4)
    // Ceiling progression: 20K → 25K → 30K → 31K → 31.5K → 32K → 36K.
    //   * 20K → 25K when item 8 of the agent-native API plan landed
    //     (additionalProperties: false on all inputSchemas + period_status in the
    //     staged operation envelope).
    //   * 25K → 30K when the agentic branch merged with main: catalog grew from
    //     ~75 to 83 tools (added gnubok_create_supplier, gnubok_list_pending_operations,
    //     gnubok_approve_pending_operation, gnubok_reject_pending_operation,
    //     gnubok_set_inbox_extracted_data from main + gnubok_get_agent_briefing,
    //     _remember_fact, _forget_fact, _feedback from the agent branch).
    //   * 30K → 31K when gnubok_match_batch_allocate and
    //     gnubok_bulk_book_transactions landed (PRs #603/#606/#608/#610). Each
    //     adds the shared STAGED_OPERATION_SCHEMA + a non-trivial inputSchema
    //     for the multi-tx flows. Descriptions already trimmed to 230–260 chars.
    //   * 31K → 31.5K when gnubok_link_transaction_to_journal_entry landed (PR
    //     #614). Same family as match_batch_allocate / bulk_book_transactions —
    //     closes the MCP parity gap with the existing REST endpoint so agents
    //     can attach a bank tx to an already-posted verifikat without creating
    //     duplicate bookkeeping. Description trimmed to ~180 chars.
    //   * 31.5K → 32K when gnubok_find_voucher_candidates_for_supplier_invoice +
    //     gnubok_link_supplier_invoice_to_voucher landed — the supplier-side
    //     mirror of the customer find/link voucher tools. The link tool inlines
    //     the shared STAGED_OPERATION_SCHEMA. Lets agents mark a leverantörs-
    //     faktura paid against an already-posted verifikat (no new bokföring),
    //     which is exactly the fix for invoices imported from Fortnox as open
    //     payables while their payment already exists in the SIE-imported GL.
    //   * 32K → 36K when top-level Tool.title (MCP spec 2025-06-18) landed on all
    //     92 tools for Connectors Directory readiness; the ~10 longest descriptions
    //     were trimmed toward 180–200 chars to partly offset. Headroom reserved for
    //     the upcoming Skatteverket tools.
    //   * Held at 36K when gnubok_list_accrual_schedules (add/bokslut) merged with
    //     the categorize vat_amount override (#717): the combination crossed the
    //     ceiling by ~75, offset by trimming the 8 longest descriptions to ~200 chars.
    //   * 36K → 38K with the MCP legibility pass: the machine-readable staging
    //     contract now emits `_meta { requires_approval, approve_tool, preflight }`
    //     on every staging write (~40 tools) so an agent can tell — without reading
    //     prose — which writes need a follow-up gnubok_approve_pending_operation and
    //     which have a pre-flight; gnubok_get_agent_briefing also gained a `company`
    //     identity block in its outputSchema. This is wire data the agent depends
    //     on, not trimmable prose — hence a bump rather than a description trim.
    //   * 38K → 40K as the catalog grew from 92 to 103 tools (gnubok_link_document_
    //     to_voucher #804, gnubok_bulk_book_inbox_items, the categorize-core additions,
    //     plus per-line supplier-invoice overrides). Each new tool carries its
    //     inputSchema + staging _meta; the growth is genuine wire data, not prose,
    //     so descriptions are already at their trimmed floor (~180–220 chars).
    //   * 40K → 42K with dimensions PR3: gnubok_list_dimensions +
    //     gnubok_list_dimension_values (nested registry output schemas) + staged
    //     gnubok_create_dimension_value (STAGED_OPERATION_SCHEMA + _meta), the
    //     dims bag + default_dimensions on create_voucher/correct_entry, and the
    //     agent-briefing dimensions block. Descriptions were trimmed first
    //     (~200 tokens recovered); the remainder is schema structure agents
    //     depend on for resolve-don't-select, not trimmable prose.
    //   * 42K → 43K with dimensions PR4 reports: gnubok_get_dimension_pnl (the
    //     value-as-column matrix outputSchema is the wire contract agents read
    //     the report through), the shared `dimensions` filter arg + echo props
    //     on trial balance / income statement / general ledger, and
    //     group_by/group_by_dimension + totals_scope + groups on
    //     gnubok_query_journal. Descriptions trimmed first (~100 tokens
    //     recovered); the ~55-token remainder is schema structure.
    // Long-term answer to growth is leaning harder on gnubok_search_tools — if this
    // fires again, prefer trimming descriptions or making a tool opt-in via search
    // before bumping further.
    expect(approxTokens).toBeLessThan(43_000)
  })
})
