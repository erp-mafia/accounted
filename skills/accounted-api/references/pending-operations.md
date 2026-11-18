<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Pending operations (approvals) endpoints

The approval door for staged writes: a write sent with `?stage=true` (or staged by an agent over MCP) waits here as a pending operation until it is approved (committed, answering the outcome) or rejected. Each one carries `status` and `task_state` (working, completed, failed, cancelled), so an attest flow built outside Accounted follows it like any other task. Approving twice never commits twice.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/pending-operations`

**List pending operations (staged writes waiting for approval).**
`scope:pending_operations:read · risk:low · idempotent`

Returns the company's pending operations newest first: writes staged for approval by an agent, an integration (`?stage=true` on a write) or the app, with what approving each will do (`preview`), its risk level and, once resolved, its `result`. Every row carries `status` (pending, committing, committed, rejected, failed_partial, unknown) and `task_state` in the MCP Tasks / A2A vocabulary: working (pending, committing), completed (committed), failed (the approved commit did not go through, or was interrupted and its outcome is unknown: check the ledger, it is never replayed), cancelled (rejected by a person, expired or superseded). Defaults to `status=pending`, the approval queue; `status=all` lists every status. Same rows as the app's review list and the MCP tool gnubok_list_pending_operations.

**Use when:** You run an approval or attest flow outside Accounted and need the queue of operations waiting for a decision, or the outcome of the ones you staged.
**Do not use for:** Supplier-invoice attest (GET /supplier-invoices and POST /supplier-invoices/{id}/approve, governed by the attest policy). Polling one operation you staged (GET /pending-operations/{id}).

**Pitfalls:**
- Without status the list is pending only; pass status=all for history.
- The staged input (params) is never returned: preview is the approver's summary.
- A cursor that no longer decodes starts from the first page again: stop on a null next_cursor.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `status` | query | `"pending" \| "committing" \| "committed" \| "rejected" \| "failed_partial" \| "unknown" \| "all"` | no | Default pending (the approval queue). all = every status. |
| `risk_level` | query | `"low" \| "medium" \| "high"` | no |  |
| `operation_type` | query | `string` | no | One operation type, e.g. create_invoice. |
| `batch_id` | query | `string` | no | Only the operations staged together under this batch. |
| `cursor` | query | `string` | no | Opaque cursor from the previous page's meta.next_cursor. Omit for the first page. |
| `limit` | query | `number` | no | Page size, 1-100 (default 50). Larger values are clamped to 100. |

Response `200`:
```ts
{
  data: { pending_operation_id: string, handle?: string, company_id: string, operation_number: number | null, operation_type: string, title: string, status: "pending" | "committing" | "committed" | "rejected" | "failed_partial" | "unknown", task_state: "working" | "completed" | "failed" | "cancelled", risk_level: "low" | "medium" | "high", preview: Record<string, unknown>, result: Record<string, unknown> | null, agent_reason: string | null, rejection_category: string | null, rejection_reason: string | null, actor_type: string, actor_id: string | null, actor_label: string | null, batch_id: string | null, created_at: string, resolved_at: string | null, links: { self: string, approve: string, reject: string } }[],
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
  "data": [
    {
      "pending_operation_id": "9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
      "company_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "operation_number": 128,
      "operation_type": "create_supplier",
      "title": "Skapa leverantör Clas Ohlson AB",
      "status": "pending",
      "task_state": "working",
      "risk_level": "medium",
      "preview": {
        "name": "Clas Ohlson AB",
        "supplier_type": "swedish_business"
      },
      "result": null,
      "agent_reason": "Clas Ohlson AB is on three supplier invoices in the inbox and is not in the supplier register yet.",
      "rejection_category": null,
      "rejection_reason": null,
      "actor_type": "api_key",
      "actor_id": "b1f04c2e-7d3a-4e5b-9c6d-0e1f2a3b4c5d",
      "actor_label": "Attestflöde",
      "batch_id": null,
      "created_at": "2026-10-15T09:12:00.000Z",
      "resolved_at": null,
      "links": {
        "self": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
        "approve": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/approve",
        "reject": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/reject"
      }
    }
  ],
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12",
    "next_cursor": null
  }
}
```

---

### `GET /api/v1/companies/{companyId}/pending-operations/{id}`

**Read one pending operation and its outcome.**
`scope:pending_operations:read · risk:low · idempotent`

Returns one pending operation: what approving it will do (`preview`), its `status` and `task_state` (working, completed, failed, cancelled) and, once resolved, its `result` (the committed ids, or why it was not done). completed, failed and cancelled never change again.

**Use when:** You staged a write with `?stage=true` (or an agent staged one) and wait for a person or your attest flow to decide it: poll until task_state is completed, failed or cancelled.
**Do not use for:** Scanning the approval queue (GET /pending-operations).

**Pitfalls:**
- An id from another company answers 404 PENDING_OPERATION_NOT_FOUND, like an unknown one.
- status committing (task_state working) means an approval is running it right now: poll again shortly.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    pending_operation_id: string,
    handle?: string,
    company_id: string,
    operation_number: number | null,
    operation_type: string,
    title: string,
    status: "pending" | "committing" | "committed" | "rejected" | "failed_partial" | "unknown",
    task_state: "working" | "completed" | "failed" | "cancelled",
    risk_level: "low" | "medium" | "high",
    preview: Record<string, unknown>,
    result: Record<string, unknown> | null,
    agent_reason: string | null,
    rejection_category: string | null,
    rejection_reason: string | null,
    actor_type: string,
    actor_id: string | null,
    actor_label: string | null,
    batch_id: string | null,
    created_at: string,
    resolved_at: string | null,
    links: { self: string, approve: string, reject: string }
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
    "pending_operation_id": "9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
    "company_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "operation_number": 128,
    "operation_type": "create_supplier",
    "title": "Skapa leverantör Clas Ohlson AB",
    "status": "pending",
    "task_state": "working",
    "risk_level": "medium",
    "preview": {
      "name": "Clas Ohlson AB",
      "supplier_type": "swedish_business"
    },
    "result": null,
    "agent_reason": "Clas Ohlson AB is on three supplier invoices in the inbox and is not in the supplier register yet.",
    "rejection_category": null,
    "rejection_reason": null,
    "actor_type": "api_key",
    "actor_id": "b1f04c2e-7d3a-4e5b-9c6d-0e1f2a3b4c5d",
    "actor_label": "Attestflöde",
    "batch_id": null,
    "created_at": "2026-10-15T09:12:00.000Z",
    "resolved_at": null,
    "links": {
      "self": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
      "approve": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/approve",
      "reject": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/reject"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pending-operations/{id}/approve`

**Approve a pending operation: commit it and answer the outcome.**
`scope:pending_operations:approve · risk:high · idempotent`

Commits a pending operation now, through the same executor as Godkänn in the app and the MCP approve tool, and answers the operation as committed: `status` committed, `task_state` completed and `result` holding what was created or posted. A high-risk operation (vouchers, corrections, storno, period lock/close, year-end, sends) needs `{"confirmed": true}` once a person has acknowledged it. Approving twice never commits twice: a second approval answers 409 PENDING_OPERATION_NOT_PENDING with the operation as it stands. Approvals are recorded with commit method api_key and the key as actor, and the key's unattended commit limit applies.

**Use when:** Your attest or approval flow (or the person it asked) has decided yes on an operation that was staged with `?stage=true` or by an agent.
**Do not use for:** Attesting a supplier invoice under the attest policy (POST /supplier-invoices/{id}/approve). Operations only a person may approve in the app (collections): those answer 403 COLLECTION_ATTESTATION_WEB_ONLY; a rule for automatic booking (create_grant) answers 403 GRANT_NEEDS_PERSON.

**Pitfalls:**
- Idempotency-Key is mandatory; a retry with the same key and body replays the first answer.
- risk_level high without confirmed=true answers 400 PENDING_OPERATION_CONFIRMATION_REQUIRED and commits nothing.
- A refused commit names where the operation landed in error.details.pending_operation: status pending means nothing was consumed and it can be approved again once the cause is fixed (e.g. ACCOUNTS_NOT_IN_CHART, UNATTENDED_COMMIT_LIMIT_EXCEEDED); rejected or failed_partial means it is resolved.
- Needs the pending_operations:approve scope; a key that also stages writes both proposes and decides, so give it only to flows that hold their own approval step.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ confirmed?: boolean }
```

Example request:
```json
{
  "confirmed": true
}
```

Response `200`:
```ts
{
  data: {
    pending_operation_id: string,
    handle?: string,
    company_id: string,
    operation_number: number | null,
    operation_type: string,
    title: string,
    status: "pending" | "committing" | "committed" | "rejected" | "failed_partial" | "unknown",
    task_state: "working" | "completed" | "failed" | "cancelled",
    risk_level: "low" | "medium" | "high",
    preview: Record<string, unknown>,
    result: Record<string, unknown> | null,
    agent_reason: string | null,
    rejection_category: string | null,
    rejection_reason: string | null,
    actor_type: string,
    actor_id: string | null,
    actor_label: string | null,
    batch_id: string | null,
    created_at: string,
    resolved_at: string | null,
    links: { self: string, approve: string, reject: string }
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
    "pending_operation_id": "9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
    "company_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "operation_number": 128,
    "operation_type": "create_supplier",
    "title": "Skapa leverantör Clas Ohlson AB",
    "status": "committed",
    "task_state": "completed",
    "risk_level": "medium",
    "preview": {
      "name": "Clas Ohlson AB",
      "supplier_type": "swedish_business"
    },
    "result": {
      "supplier_id": "2c4e…"
    },
    "agent_reason": "Clas Ohlson AB is on three supplier invoices in the inbox and is not in the supplier register yet.",
    "rejection_category": null,
    "rejection_reason": null,
    "actor_type": "api_key",
    "actor_id": "b1f04c2e-7d3a-4e5b-9c6d-0e1f2a3b4c5d",
    "actor_label": "Attestflöde",
    "batch_id": null,
    "created_at": "2026-10-15T09:12:00.000Z",
    "resolved_at": "2026-10-15T09:14:03.000Z",
    "links": {
      "self": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
      "approve": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/approve",
      "reject": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/reject"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pending-operations/{id}/reject`

**Reject a pending operation without committing it.**
`scope:pending_operations:approve · risk:low · idempotent`

Resolves a pending operation as rejected: nothing is booked, sent or created. Answers the operation with `status` rejected and `task_state` cancelled. `category` and `reason` are optional and kept with it, so the agent or flow that staged it can learn why. An operation that is no longer pending (already approved, rejected or expired, or claimed by an approval running right now) answers 409 PENDING_OPERATION_NOT_PENDING and is left as it is. Same write as Avvisa in the app and the MCP reject tool.

**Use when:** Your attest or approval flow (or the person it asked) has decided no on a pending operation.
**Do not use for:** Undoing a committed operation: reverse or correct what it posted instead (POST /journal-entries/{id}/reverse or /correct, or credit the invoice).

**Pitfalls:**
- Idempotency-Key is mandatory.
- Needs the pending_operations:approve scope, as approving does.
- reason is 1-500 characters.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{
  category?: "wrong_category" | "wrong_amount" | "duplicate" | "wrong_period" | "other",
  reason?: string
}
```

Example request:
```json
{
  "category": "wrong_amount",
  "reason": "Beloppet stämmer inte med fakturan."
}
```

Response `200`:
```ts
{
  data: {
    pending_operation_id: string,
    handle?: string,
    company_id: string,
    operation_number: number | null,
    operation_type: string,
    title: string,
    status: "pending" | "committing" | "committed" | "rejected" | "failed_partial" | "unknown",
    task_state: "working" | "completed" | "failed" | "cancelled",
    risk_level: "low" | "medium" | "high",
    preview: Record<string, unknown>,
    result: Record<string, unknown> | null,
    agent_reason: string | null,
    rejection_category: string | null,
    rejection_reason: string | null,
    actor_type: string,
    actor_id: string | null,
    actor_label: string | null,
    batch_id: string | null,
    created_at: string,
    resolved_at: string | null,
    links: { self: string, approve: string, reject: string }
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
    "pending_operation_id": "9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
    "company_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "operation_number": 128,
    "operation_type": "create_supplier",
    "title": "Skapa leverantör Clas Ohlson AB",
    "status": "rejected",
    "task_state": "cancelled",
    "risk_level": "medium",
    "preview": {
      "name": "Clas Ohlson AB",
      "supplier_type": "swedish_business"
    },
    "result": null,
    "agent_reason": "Clas Ohlson AB is on three supplier invoices in the inbox and is not in the supplier register yet.",
    "rejection_category": "wrong_amount",
    "rejection_reason": "Beloppet stämmer inte med fakturan.",
    "actor_type": "api_key",
    "actor_id": "b1f04c2e-7d3a-4e5b-9c6d-0e1f2a3b4c5d",
    "actor_label": "Attestflöde",
    "batch_id": null,
    "created_at": "2026-10-15T09:12:00.000Z",
    "resolved_at": "2026-10-15T09:14:03.000Z",
    "links": {
      "self": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
      "approve": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/approve",
      "reject": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/reject"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/pending-operations/{id}/withdraw`

**Withdraw a pending operation this key staged itself.**
`risk:low · idempotent`

Takes back a pending operation the calling key staged (`?stage=true`, or an MCP staging tool on the same key) while it still waits for approval: it leaves the approval queue and nothing is booked, sent or created. Answers the operation with `status` rejected, `task_state` cancelled, `rejection_category` superseded and `result.withdrawn` true. Needs no particular scope, and never pending_operations:approve: the key must be the one that staged the operation. An operation staged by another key or by a person answers 403; one that is no longer pending (approved, rejected, expired, or being committed right now) answers 409 PENDING_OPERATION_NOT_PENDING and is left as it is. Repeating the call on an operation this key already withdrew answers 200 with the same operation.

**Use when:** Your integration staged a proposal by mistake (a duplicate, a wrong amount) and will stage a corrected one.
**Do not use for:** Saying no to somebody else's proposal: that is POST /pending-operations/{id}/reject, which needs pending_operations:approve. Undoing a committed operation: reverse or correct what it posted.

**Pitfalls:**
- Idempotency-Key is mandatory.
- Only operations staged by the calling key, with that key (a new key for the same integration does not own the old key's proposals).
- reason is 1-300 characters.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ reason?: string }
```

Example request:
```json
{
  "reason": "Dubblett av ett tidigare förslag."
}
```

Response `200`:
```ts
{
  data: {
    pending_operation_id: string,
    handle?: string,
    company_id: string,
    operation_number: number | null,
    operation_type: string,
    title: string,
    status: "pending" | "committing" | "committed" | "rejected" | "failed_partial" | "unknown",
    task_state: "working" | "completed" | "failed" | "cancelled",
    risk_level: "low" | "medium" | "high",
    preview: Record<string, unknown>,
    result: Record<string, unknown> | null,
    agent_reason: string | null,
    rejection_category: string | null,
    rejection_reason: string | null,
    actor_type: string,
    actor_id: string | null,
    actor_label: string | null,
    batch_id: string | null,
    created_at: string,
    resolved_at: string | null,
    links: { self: string, approve: string, reject: string }
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
    "pending_operation_id": "9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
    "company_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "operation_number": 128,
    "operation_type": "create_supplier",
    "title": "Skapa leverantör Clas Ohlson AB",
    "status": "rejected",
    "task_state": "cancelled",
    "risk_level": "medium",
    "preview": {
      "name": "Clas Ohlson AB",
      "supplier_type": "swedish_business"
    },
    "result": null,
    "agent_reason": "Clas Ohlson AB is on three supplier invoices in the inbox and is not in the supplier register yet.",
    "rejection_category": "superseded",
    "rejection_reason": "Återtaget av agenten som lade förslaget: Dubblett av ett tidigare förslag.",
    "actor_type": "api_key",
    "actor_id": "b1f04c2e-7d3a-4e5b-9c6d-0e1f2a3b4c5d",
    "actor_label": "Attestflöde",
    "batch_id": null,
    "created_at": "2026-10-15T09:12:00.000Z",
    "resolved_at": "2026-10-15T09:14:03.000Z",
    "links": {
      "self": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f",
      "approve": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/approve",
      "reject": "/api/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/pending-operations/9a44c0de-1f2b-4c3d-8e4f-5a6b7c8d9e0f/reject"
    }
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
