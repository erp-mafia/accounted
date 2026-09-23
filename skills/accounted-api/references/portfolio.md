<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Portfolio endpoints

Cross-company reads for keys that reach more than one company (consultants, byrå team members, multi-company owners): one call over a membership-checked company scope instead of one call per company. The scope is capped at 25 companies per call; the response names the ids beyond the cap so the next call can list them explicitly.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/portfolio/overview`

**Cross-company overview: unbooked, inbox and next deadline per company the key can reach.**
`scope:companies:read · risk:low · idempotent`

One read over many companies: for every company in scope, the unbooked bank transactions, the unconsumed inbox documents, the next open deadline with its urgency, the latest booked date and the open deadlines (earliest first, at most 10). Rows are urgency-sorted: overdue deadline first, then the largest unbooked pile. The scope is every non-archived company the key user is a member of (default), the key user's byrå team (team=true), or an explicit comma-separated companies list; exclude removes ids from any of them. The scope is capped at 25 companies per call: scope.truncated says so and scope.remaining_company_ids lists the rest so the next call can pass them as companies. The filters (deadline_kind, deadline_within_days, min_unbooked, min_inbox) narrow the rows; summary.companies is the scope size and summary.matched the rows left.

**Use when:** The key reaches several companies and you need to know where to work first: which companies have VAT due this week, who has unbooked transactions piling up, whose inbox is waiting.
**Do not use for:** A single company (GET /api/v1/companies/{companyId} plus its per-resource lists), or discovering company ids: GET /api/v1/companies lists them without the numbers.

**Pitfalls:**
- Unknown, archived or non-member ids in companies do not fail the call: they come back in scope.unresolved with a 200. Check it before trusting an empty result.
- team=true with no byrå team returns an empty scope and team: null, not an error. A byrå member without client companies also gets an empty scope, with team set.
- More than 25 companies in scope: the response is truncated (scope.truncated) and scope.remaining_company_ids carries the ids beyond the cap. Call again with companies=<those ids>.
- deadline_kind matches deadlines.tax_deadline_type, so custom deadlines (no tax type) never match a kind; deadline_within_days alone looks at the next deadline of any kind, custom included.
- next_deadline is the earliest open deadline of ANY kind even when deadline_kind is set; read deadlines[] for the one that matched.
- Counts follow the same predicates as the app (unbooked: is_business unset and not ignored; inbox: a document that has become nothing yet), so they equal what the user sees in Att göra.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companies` | query | `string` | no | Comma-separated company ids to read, in this order. Omitted: every company the key can access. |
| `team` | query | `"true" \| "false"` | no | true: only the companies on the key user's byrå team. Cannot be combined with companies. |
| `exclude` | query | `string` | no | Comma-separated company ids to leave out. |
| `deadline_kind` | query | `"vat" \| "agi" \| "f_skatt" \| "inkomstdeklaration" \| "arsredovisning" \| "any"` | no | Keep companies with an open deadline of this kind: vat (moms incl. OSS/IOSS), agi (arbetsgivardeklaration), f_skatt (F-skatt and skatteinbetalning), inkomstdeklaration, arsredovisning (incl. arsstamma), any (any tax deadline). |
| `deadline_within_days` | query | `number` | no | Keep companies whose deadline (of deadline_kind, else the next of any kind) is due within N days, overdue included. |
| `min_unbooked` | query | `number` | no | Keep companies with at least this many unbooked bank transactions. |
| `min_inbox` | query | `number` | no | Keep companies with at least this many unconsumed inbox documents. |

Response `200`:
```ts
{
  data: {
    team: { id: string, name: string } | null,
    scope: { truncated: boolean, remaining_company_ids: string[], unresolved: string[] },
    summary: { companies: number, matched: number, unbooked_total: number, inbox_total: number, overdue: number, action_needed: number },
    companies: { company_id: string, name: string, org_number: string | null, entity_type: string | null, role: "owner" | "admin" | "member" | "viewer", team_id: string | null, unbooked_count: number, inbox_count: number, next_deadline: { title: string, due_date: string, tax_deadline_type: string | null, urgency: "overdue" | "action_needed" | "upcoming" } | null, last_booked_date: string | null, deadlines: { title: string, due_date: string, tax_deadline_type: string | null, urgency: "overdue" | "action_needed" | "upcoming" }[] }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string | null,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    warnings?: { code: string, message_sv: string, message_en: string, remediation?: { description: string, tool?: string, args?: Record<string, unknown>, resource?: string } }[],
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "team": {
      "id": "2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10",
      "name": "Siffra Redovisning"
    },
    "scope": {
      "truncated": false,
      "remaining_company_ids": [],
      "unresolved": []
    },
    "summary": {
      "companies": 2,
      "matched": 2,
      "unbooked_total": 14,
      "inbox_total": 3,
      "overdue": 1,
      "action_needed": 0
    },
    "companies": [
      {
        "company_id": "8fd5b1f4-0000-4000-8000-000000000001",
        "name": "Acme AB",
        "org_number": "556677-8899",
        "entity_type": "aktiebolag",
        "role": "member",
        "team_id": "2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10",
        "unbooked_count": 11,
        "inbox_count": 3,
        "next_deadline": {
          "title": "Momsdeklaration",
          "due_date": "2026-09-12",
          "tax_deadline_type": "moms_quarterly",
          "urgency": "overdue"
        },
        "last_booked_date": "2026-08-28",
        "deadlines": [
          {
            "title": "Momsdeklaration",
            "due_date": "2026-09-12",
            "tax_deadline_type": "moms_quarterly",
            "urgency": "overdue"
          },
          {
            "title": "Arbetsgivardeklaration",
            "due_date": "2026-10-12",
            "tax_deadline_type": "arbetsgivardeklaration",
            "urgency": "upcoming"
          }
        ]
      },
      {
        "company_id": "8fd5b1f4-0000-4000-8000-000000000002",
        "name": "Beta Konsult",
        "org_number": null,
        "entity_type": "enskild_firma",
        "role": "member",
        "team_id": "2a7a9e8c-4c2e-4a68-9a1a-4f0f6f3f2a10",
        "unbooked_count": 3,
        "inbox_count": 0,
        "next_deadline": null,
        "last_booked_date": "2026-09-15",
        "deadlines": []
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
