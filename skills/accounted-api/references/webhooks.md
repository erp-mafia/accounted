<!-- GENERATED FILE, do not edit. Source: lib/api/v1 registry + scripts/api-skill/overlays. Regenerate with `npm run apiskill:generate`. -->

# Webhooks endpoints

HMAC-signed event subscriptions with delivery logs, test pings, retries, and secret rotation.

Conventions (auth, envelope, pagination, dry-run, idempotency, standard errors)
are in SKILL.md and are not repeated per endpoint.

### `GET /api/v1/companies/{companyId}/webhooks`

**List webhook subscriptions for a company.**
`scope:webhooks:manage · risk:low · idempotent`

Returns all webhook subscriptions for the company. The HMAC signing secret is never exposed by this endpoint: it is returned exactly once when the webhook is created.

**Use when:** You need to enumerate the webhook subscriptions an integration has registered, e.g. to build a UI listing or sync state with an external system.
**Do not use for:** Reading delivery history (use GET /webhooks/{id}/deliveries). Reading the secret (it is unrecoverable after the create response: generate a new webhook if lost).

**Pitfalls:**
- Disabled webhooks (auto-disabled after HTTP 410, or manually disabled via PATCH) appear in the list with active=false and a disabled_reason.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    webhooks: { id: string, name: string, event_type: string, webhook_url: string, active: boolean, api_version_pinned: string, disabled_at: string, disabled_reason: string, created_at: string }[]
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "webhooks": [
      {
        "id": "a8f1…",
        "name": "CRM sync",
        "event_type": "invoice.paid",
        "webhook_url": "https://example.com/hooks/gnubok",
        "active": true,
        "api_version_pinned": "2026-05-12",
        "disabled_at": null,
        "disabled_reason": null,
        "created_at": "2026-05-15T12:00:00Z"
      }
    ]
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/webhooks`

**Register a webhook subscription.**
`scope:webhooks:manage · risk:low · idempotent · dry-run · reversible`

Creates a webhook subscription for one event type. The response includes a freshly generated HMAC signing secret, returned EXACTLY ONCE: store it on the receiver side immediately. The webhook is pinned to the current API version on creation; payload shapes for this webhook will not change until you explicitly upgrade.

**Use when:** You are wiring a downstream integration that needs push notifications instead of polling.
**Do not use for:** Subscribing to internal MCP telemetry events (mcp.tool_called etc. are not delivered as webhooks). Replacing an existing webhook URL: use PATCH instead.

**Pitfalls:**
- The secret is returned exactly once. If lost, rotate it with POST /webhooks/{id}/rotate-secret: a fresh secret is issued in place, the webhook id and delivery history are kept.
- Delivery is at-least-once with exponential backoff (1m / 5m / 30m / 2h / 12h / 24h / 48h). Receivers MUST be idempotent.
- HTTP 410 from your receiver auto-disables the webhook (sets active=false + disabled_reason).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |

Request body:
```ts
{
  event_type: "invoice.created" | "invoice.sent" | "invoice.paid" | "credit_note.created" | "supplier.created" | "supplier_invoice.registered" | "supplier_invoice.approved" | "supplier_invoice.paid" | "supplier_invoice.credited" | "supplier_invoice.uncredited" | "customer.created" | "journal_entry.committed" | "journal_entry.reversed" | "journal_entry.corrected" | "transaction.categorized" | "transaction.reconciled" | "reconciliation.matched" | "reconciliation.unmatched" | "reconciliation.signed_off" | "reconciliation.reopened" | "period.locked" | "period.unlocked" | "period.year_closed" | "salary_run.created" | "salary_run.approved" | "salary_run.booked" | "agi.generated" | "document.uploaded",
  webhook_url: string,
  name: string,
  description?: string
}
```

Example request:
```json
{
  "event_type": "invoice.paid",
  "webhook_url": "https://example.com/hooks/gnubok",
  "name": "CRM sync"
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    event_type: string,
    webhook_url: string,
    active: boolean,
    api_version_pinned: string,
    disabled_at: string,
    disabled_reason: string,
    created_at: string,
    secret: string,
    description: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "name": "CRM sync",
    "event_type": "invoice.paid",
    "webhook_url": "https://example.com/hooks/gnubok",
    "active": true,
    "api_version_pinned": "2026-05-12",
    "disabled_at": null,
    "disabled_reason": null,
    "secret": "whsec_…",
    "description": null,
    "created_at": "2026-05-15T12:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `GET /api/v1/companies/{companyId}/webhooks/{id}`

**Get a webhook subscription by id.**
`scope:webhooks:manage · risk:low · idempotent`

Returns the webhook configuration. The HMAC signing secret is never exposed.

**Use when:** You need the current state of a single webhook (e.g. to render a settings page).
**Do not use for:** Reading the secret (returned only once on creation).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    description: string,
    event_type: string,
    webhook_url: string,
    active: boolean,
    api_version_pinned: string,
    disabled_at: string,
    disabled_reason: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "name": "CRM sync",
    "description": null,
    "event_type": "invoice.paid",
    "webhook_url": "https://example.com/hooks/gnubok",
    "active": true,
    "api_version_pinned": "2026-05-12",
    "disabled_at": null,
    "disabled_reason": null,
    "created_at": "2026-05-15T12:00:00Z",
    "updated_at": "2026-05-15T12:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `PATCH /api/v1/companies/{companyId}/webhooks/{id}`

**Update a webhook subscription.**
`scope:webhooks:manage · risk:low · idempotent · dry-run · reversible`

Update the URL, name, description, or active flag. event_type is immutable: delete and recreate to change it. Setting active=false manually pauses delivery without deleting; setting active=true clears any disabled_at/disabled_reason set by the auto-disable on HTTP 410.

**Use when:** You need to point an existing webhook at a new URL or temporarily pause delivery.
**Do not use for:** Rotating the signing secret: use POST /webhooks/{id}/rotate-secret, which issues a fresh secret in place and keeps the webhook id and delivery history. Changing event_type: delete and recreate.

**Pitfalls:**
- Re-enabling a webhook (active: true) does NOT replay deliveries that went to dead status while it was disabled: those need POST /webhook-deliveries/{id}/retry.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Request body:
```ts
{ name?: string, description?: string, webhook_url?: string, active?: boolean }
```

Example request:
```json
{
  "active": true
}
```

Response `200`:
```ts
{
  data: {
    id: string,
    name: string,
    description: string,
    event_type: string,
    webhook_url: string,
    active: boolean,
    api_version_pinned: string,
    disabled_at: string,
    disabled_reason: string,
    created_at: string,
    updated_at: string
  },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "name": "CRM sync",
    "description": null,
    "event_type": "invoice.paid",
    "webhook_url": "https://example.com/hooks/gnubok",
    "active": true,
    "api_version_pinned": "2026-05-12",
    "disabled_at": null,
    "disabled_reason": null,
    "created_at": "2026-05-15T12:00:00Z",
    "updated_at": "2026-05-15T12:05:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `DELETE /api/v1/companies/{companyId}/webhooks/{id}`

**Delete a webhook subscription.**
`scope:webhooks:manage · risk:medium · idempotent`

Hard-deletes the webhook. The delivery audit trail SURVIVES: both terminal (delivered, dead) and non-terminal (pending, failed) delivery rows persist with webhook_id = NULL so the BFNAR 2013:2 kap 8 § behandlingshistorik (7-year retention) for accounting-event deliveries is preserved. Non-terminal rows go dormant (the dispatcher skips them).

**Use when:** You no longer want this webhook to receive events.
**Do not use for:** Temporarily pausing delivery: use PATCH with active=false instead so the configuration survives.

**Pitfalls:**
- Audit history survives DELETE; only the receiver subscription is removed. To suppress future events without retaining the registration use PATCH active=false.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `204`.

---

### `GET /api/v1/companies/{companyId}/webhooks/{id}/deliveries`

**List deliveries for a webhook subscription.**
`scope:webhooks:manage · risk:low · idempotent`

Returns deliveries for the webhook in newest-first order. Each row carries the current status (pending / in_flight / delivered / failed / dead), the attempt count, the next scheduled retry time, and the captured response details from the last attempt.

**Use when:** You are debugging a flaky receiver, or building a delivery-history UI for a settings page.
**Do not use for:** Listing deliveries across multiple webhooks (this endpoint is single-webhook scoped).

**Pitfalls:**
- response_body is truncated to 4 KB: receivers returning long error pages have their response truncated.
- A delivery in `failed` status is non-terminal: the dispatcher will retry it at next_attempt_at. `dead` is terminal.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, webhook_id: string, event_type: string, status: "pending" | "in_flight" | "delivered" | "failed" | "dead", attempts: number, next_attempt_at: string, response_status: number, response_body: string, error: string, request_id: string, created_at: string, delivered_at: string }[],
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
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
      "id": "wh_dlv_…",
      "webhook_id": "a8f1…",
      "event_type": "invoice.paid",
      "status": "delivered",
      "attempts": 1,
      "next_attempt_at": "2026-05-15T12:00:00Z",
      "response_status": 200,
      "response_body": "ok",
      "error": null,
      "request_id": "whdel_…",
      "created_at": "2026-05-15T12:00:00Z",
      "delivered_at": "2026-05-15T12:00:01Z"
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

### `POST /api/v1/companies/{companyId}/webhooks/{id}/rotate-secret`

**Rotate the HMAC signing secret on a webhook.**
`scope:webhooks:manage · risk:medium`

Generates a fresh HMAC signing secret for the webhook and returns it EXACTLY ONCE. The previous secret is invalidated immediately. There is no grace period: coordinate the rotation on the receiver side BEFORE calling this endpoint, or temporarily disable the webhook (PATCH active=false) to pause delivery while you swap secrets.

**Use when:** After a suspected secret leak, on a routine rotation cadence (Stripe pattern: every 90 days for compliance-grade integrations), or when changing the receiver implementation and you want to invalidate the old secret deliberately.
**Do not use for:** Routine integration setup: the secret returned at create time is the canonical one. Recovering a lost secret (rotation does not recover the prior value; it issues a fresh one).

**Pitfalls:**
- The secret is returned exactly once. If you lose this response, the recovery path is to rotate again.
- In-flight deliveries between the rotation and the receiver-side update may fail signature verification on the new secret. Pause the webhook (PATCH active=false) first if your tolerance for that window is zero.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { id: string, secret: string, rotated_at: string },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "id": "a8f1…",
    "secret": "whsec_…",
    "rotated_at": "2026-05-15T12:00:00Z"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/companies/{companyId}/webhooks/{id}/test`

**Send a synthetic test event to a webhook.**
`scope:webhooks:manage · risk:low`

Enqueues a webhook.test delivery against the configured receiver and dispatches it immediately, so the outcome is normally available within a second or two rather than on the next per-minute cron tick. Use the returned webhook_delivery_id to poll GET /webhooks/{id}/deliveries for the outcome.

**Use when:** After creating or modifying a webhook, before relying on it in production: to validate that the receiver is reachable and that signature verification works on the receiver side.
**Do not use for:** Smoke-testing the dispatcher itself (use a real event). Replaying a failed delivery (use POST /webhook-deliveries/{id}/retry).

**Pitfalls:**
- Test deliveries follow the same retry policy as real events: a 500 from your receiver will retry 7 times over ~87h (about 3.6 days). Use a 2xx ack-only handler if you want a clean signal.

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `companyId` | path | `string` | yes |  |
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { webhook_delivery_id: string, status: "pending" },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "webhook_delivery_id": "wh_dlv_…",
    "status": "pending"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```

---

### `POST /api/v1/webhook-deliveries/{id}/retry`

**Retry a webhook delivery.**
`scope:webhooks:manage · risk:medium`

Re-enqueues a dead (or delivered) delivery as a fresh pending row. The new delivery references the same webhook + payload; the dispatcher picks it up at the next per-minute cron tick. The original row is preserved in the audit log.

**Use when:** After a receiver outage you want to replay deliveries that died, or after fixing a receiver-side bug you want to redeliver a successful one.
**Do not use for:** Retrying live deliveries (pending / in_flight / failed): the dispatcher is already managing them.

**Pitfalls:**
- Retrying a delivered delivery causes the receiver to see the event twice. Receivers MUST be idempotent (check the X-Gnubok-Delivery header).

| Parameter | In | Type | Required | Notes |
|---|---|---|---|---|
| `id` | path | `string` | yes |  |

Response `200`:
```ts
{
  data: { webhook_delivery_id: string, status: "pending" },
  meta: {
    request_id: string,
    api_version: string,
    next_cursor?: string,
    audit?: { voucher_number?: string, voucher_url?: string, audit_trail_url?: string, immutable_at?: string },
    partial_expansions?: string[],
    coverage?: Record<string, unknown>
  }
}
```

Example response `200`:
```json
{
  "data": {
    "webhook_delivery_id": "wh_dlv_NEW",
    "status": "pending"
  },
  "meta": {
    "request_id": "req_…",
    "api_version": "2026-05-12"
  }
}
```
