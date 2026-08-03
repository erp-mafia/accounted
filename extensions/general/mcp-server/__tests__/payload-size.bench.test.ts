import { describe, it, expect } from 'vitest'
import { tools, deriveToolMeta, isDefaultCatalogTool } from '../server'
import { projectToolInputSchema } from '../company-routing'

describe('tools/list payload size guard', () => {
  it('keeps the projected tools/list payload under the context-budget ceiling', () => {
    // Mirror the real tools/list serializer, including the derived staging
    // _meta (requires_approval / approve_tool / preflight) merged over any
    // literal _meta: otherwise the guard under-measures the wire payload.
    const projection = tools.filter(isDefaultCatalogTool).map((t) => {
      const meta = { ...(deriveToolMeta(t) ?? {}), ...(t._meta ?? {}) }
      return {
        name: t.name,
        ...(t.title ? { title: t.title } : {}),
        description: t.description,
        inputSchema: projectToolInputSchema(t),
        ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
        annotations: t.annotations,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
      }
    })
    const payload = JSON.stringify({ tools: projection })
    const approxTokens = Math.round(payload.length / 4)
    // Ceiling progression: 20K to 25K to 30K to 31K to 31.5K to 32K to 36K.
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
    //     for the multi-tx flows. Descriptions already trimmed to 230-260 chars.
    //   * 31K → 31.5K when gnubok_link_transaction_to_journal_entry landed (PR
    //     #614). Same family as match_batch_allocate / bulk_book_transactions:
    //     closes the MCP parity gap with the existing REST endpoint so agents
    //     can attach a bank tx to an already-posted verifikat without creating
    //     duplicate bookkeeping. Description trimmed to ~180 chars.
    //   * 31.5K → 32K when gnubok_find_voucher_candidates_for_supplier_invoice +
    //     gnubok_link_supplier_invoice_to_voucher landed: the supplier-side
    //     mirror of the customer find/link voucher tools. The link tool inlines
    //     the shared STAGED_OPERATION_SCHEMA. Lets agents mark a leverantörs-
    //     faktura paid against an already-posted verifikat (no new bokföring),
    //     which is exactly the fix for invoices imported from Fortnox as open
    //     payables while their payment already exists in the SIE-imported GL.
    //   * 32K → 36K when top-level Tool.title (MCP spec 2025-06-18) landed on all
    //     92 tools for Connectors Directory readiness; the ~10 longest descriptions
    //     were trimmed toward 180-200 chars to partly offset. Headroom reserved for
    //     the upcoming Skatteverket tools.
    //   * Held at 36K when gnubok_list_accrual_schedules (add/bokslut) merged with
    //     the categorize vat_amount override (#717): the combination crossed the
    //     ceiling by ~75, offset by trimming the 8 longest descriptions to ~200 chars.
    //   * 36K → 38K with the MCP legibility pass: the machine-readable staging
    //     contract now emits `_meta { requires_approval, approve_tool, preflight }`
    //     on every staging write (~40 tools) so an agent can tell: without reading
    //     prose: which writes need a follow-up gnubok_approve_pending_operation and
    //     which have a pre-flight; gnubok_get_agent_briefing also gained a `company`
    //     identity block in its outputSchema. This is wire data the agent depends
    //     on, not trimmable prose: hence a bump rather than a description trim.
    //   * 38K → 40K as the catalog grew from 92 to 103 tools (gnubok_link_document_
    //     to_voucher #804, gnubok_bulk_book_inbox_items, the categorize-core additions,
    //     plus per-line supplier-invoice overrides). Each new tool carries its
    //     inputSchema + staging _meta; the growth is genuine wire data, not prose,
    //     so descriptions are already at their trimmed floor (~180-220 chars).
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
    //   * 43K → 44K with dimensions PR7 producers: default_dimensions + per-item/
    //     per-line dims bags on gnubok_create_invoice, gnubok_create_supplier_
    //     invoice_from_inbox, gnubok_categorize_transaction and
    //     gnubok_bulk_book_transactions (8 new object properties). Descriptions
    //     already use the compact "Dims bag" form (~90 tokens trimmed first);
    //     the remainder is schema structure the resolve-don't-select contract
    //     depends on, not trimmable prose.
    //   * 44K → 45K when the rot/rut branch merged with main: main's #877 put
    //     qualified identifiers in all tool output schemas (+~260 across 103
    //     tools: wire contract, not prose) and the branch added
    //     gnubok_generate_rot_rut_file (~444: begäran-om-utbetalning file flow,
    //     eligible/blocked per-invoice output). Each side alone was under the
    //     ceiling; the combination crossed it by ~220. Descriptions are at
    //     their trimmed floor per the entries above.
    //   * 45K → 45.5K when payment_link_url landed on gnubok_create_invoice
    //     (manual payment-link MVP): one optional string property with an
    //     already-minimal ~24-token description. Headroom before the change was
    //     under 10 tokens, so even this smallest possible addition crossed;
    //     other descriptions are at their trimmed floor per the entries above.
    //   * 45.5K → 50K with the payroll gap-closure (8 tools): 3 reads
    //     (gnubok_get_employee, gnubok_get_payslip, gnubok_list_absence) + 5
    //     staged writes (update_payslip_line, register_absence,
    //     create_employee, update_employee, set_employee_opening_balances).
    //     create/update_employee carry the full employee-config inputSchema
    //     (~27 properties each: the whole point is agent-driveable payroll
    //     onboarding), and every staged write inlines STAGED_OPERATION_SCHEMA
    //     + _meta. Property descriptions trimmed to enum-only where the name
    //     is self-evident; the remainder is wire contract, not prose.
    //   * 50K → 51K with the vacation workflow (gap-closure Phase 3):
    //     gnubok_get_vacation_balance (ledger read) + gnubok_close_vacation_year
    //     (staged HIGH semesterårsavslut with STAGED_OPERATION_SCHEMA + _meta).
    //     Fortnox gap category E closed; both schemas already minimal.
    //   * 51K to 54K for stateless multi-company MCP routing. Every
    //     company-dependent tool must expose the optional company_id input so
    //     the client can target another authorized company without shared
    //     mutable connection state. The repeated property is intentionally
    //     minimal; gnubok_list_companies and initialize instructions explain it.
    //   * 54K → 56K with kontoplan management + verifikat notes (MCP parity
    //     requested by an MCP-driven user): staged gnubok_create_account /
    //     gnubok_update_account (kontoplan reference data, BAS 2026 prefill)
    //     + gnubok_set_voucher_note (notes-only annotation, trigger-guarded),
    //     each inlining STAGED_OPERATION_SCHEMA + _meta + company_id routing.
    //     Descriptions and property prose trimmed first; the remainder is
    //     wire contract.
    //   * 56K → 57K with payroll e2e parity: staged gnubok_book_salary_run
    //     (advances the run through godkänd/utbetald and posts the lön
    //     verifikat: closes the "booking happens in the web UI" gap) +
    //     gnubok_delete_absence (inverse of register_absence), both inlining
    //     STAGED_OPERATION_SCHEMA + _meta + company_id routing. Descriptions
    //     trimmed to the floor first; the remainder is wire contract.
    //   * 57K → 57.5K with recommended_tools on gnubok_get_agent_briefing
    //     (#1098): the per-workflow tool-loadout array in the outputSchema
    //     (~175 tokens) lets deferred-loading harnesses batch-load a whole
    //     workflow cluster in one ToolSearch select call instead of 4-6
    //     discovery round-trips. Schema prose trimmed to the floor first;
    //     headroom before the change was ~15 tokens, and the remainder is
    //     the wire contract agents read the loadout through.
    //   * 57.5K → 58K with the run-scoped AGI filing contract on
    //     gnubok_agi_status (filing_state enum + kvittensnummer + run-scoped
    //     local_state): a correction run must be able to tell, from the wire
    //     contract alone, that it is unfiled for this run even though the
    //     period record holds the superseded original's receipt (a correction
    //     is a full resubmission with its own kvittens). Descriptions were
    //     trimmed to the floor first (agi_status, lock_period, list_employees
    //     gave back ~100 tokens); the ~90-token remainder is the contract
    //     agents read the filing state through.
    //   * 58K → 58.5K with the approval-queue widget: render_ui on
    //     gnubok_list_pending_operations opens the MCP Apps queue where
    //     approve/reject (and the high-risk BFL acknowledgment) are first-party
    //     human clicks instead of agent-asserted confirmed=true. The property +
    //     hint prose was trimmed to the floor first (~30 tokens recovered);
    //     headroom before the change was ~14 tokens, so even the trimmed wire
    //     contract crossed.
    //   * 58.5K → 59K with the model-free upload pair (#748):
    //     gnubok_create_document_upload + gnubok_complete_document_upload move
    //     document bytes out of the model context via a signed PUT URL, fixing
    //     silent base64 corruption on real-size PDFs. Neither tool can be
    //     search-only: the pair is the primary upload path for harnesses with
    //     file access, and the legacy inline tool stays listed for clients
    //     without it. Trimmed first: the create tool's outputSchema was cut to
    //     upload_id/upload_url/expires_at (method, size cap and echo fields
    //     moved to description prose) and mime_type made optional on complete;
    //     the ~360-token remainder is the two tools' wire contract.
    // Long-term answer to growth is leaning harder on gnubok_search_tools: if this
    // fires again, prefer trimming descriptions or making a tool opt-in via search
    // before bumping further.
    expect(approxTokens).toBeLessThan(59_000)
  })
})
