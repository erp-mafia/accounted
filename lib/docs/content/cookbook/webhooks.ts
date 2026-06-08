export const COOKBOOK_WEBHOOKS_MD = `# Cookbook — set up webhooks and verify signatures end-to-end

> Subscribe a receiver to invoice events, verify HMAC signatures correctly, handle the at-least-once retry semantics, and build idempotency around the delivery id.

This is the operational companion to the [Webhooks concept page](/docs/api/webhooks) — that page explains *what* webhooks are; this one walks through *how* to wire one up correctly the first time.

## What you'll need

- A test API key with \`webhooks:manage\` scope (and \`payroll:read\` if you intend to subscribe to payroll events).
- A receiver URL that Accounted can POST to. For local development use [smee.io](https://smee.io) or \`ngrok\` — Accounted refuses webhook URLs that resolve to private IPs (SSRF protection), so localhost won't work directly.
- HTTPS only — \`http://\` URLs are rejected at registration.

## 1. Register the webhook

The response includes the HMAC signing secret **exactly once**. Capture it immediately and store it on the receiver side as an environment variable.

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/webhooks" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{
    "event_type": "invoice.paid",
    "webhook_url": "https://my-receiver.example.com/gnubok",
    "name": "CRM sync — invoice paid"
  }'
\`\`\`

Response:

\`\`\`json
{
  "data": {
    "id": "wh_a8f1...",
    "name": "CRM sync — invoice paid",
    "event_type": "invoice.paid",
    "webhook_url": "https://my-receiver.example.com/gnubok",
    "active": true,
    "api_version_pinned": "2026-05-12",
    "secret": "whsec_b3a7c9e2...",
    "created_at": "2026-05-15T12:00:00Z"
  },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

> ⚠️ The \`secret\` field is returned only on creation. Subsequent GETs never include it. If you lose it, the recovery path is to delete the webhook and create a new one (which generates a fresh secret); receivers must re-deploy with the new value.

**Store the secret in a secrets manager** (AWS Secrets Manager, GCP Secret Manager, HashiCorp Vault, Doppler, 1Password Connect, ...) rather than a plaintext \`.env\` file or a config commit. The secret is signing material — anyone who reads it can forge events that will pass your signature check. Treat it with the same care as a database password.

## 2. Implement signature verification

Use the [Node](https://app.gnubok.se/docs/api/webhooks#nodejs) or [Python](https://app.gnubok.se/docs/api/webhooks#python) sample on the concept page. The critical detail: capture the **raw request body** before any framework JSON-parses it. Re-serialising the body produces different bytes and the signature won't match.

For an Express handler, that means \`express.raw({ type: 'application/json' })\` — NOT the default \`express.json()\` middleware. For FastAPI / Flask use \`request.get_data()\`. For Cloudflare Workers use \`await request.text()\` BEFORE \`request.json()\`.

## 3. Send a test event

The \`:test\` verb enqueues a synthetic \`webhook.test\` delivery without driving real state. The dispatcher sends it on the next per-minute cron tick.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/webhooks/$WEBHOOK_ID/test" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response:

\`\`\`json
{
  "data": { "webhook_delivery_id": "wh_dlv_...", "status": "pending" },
  "meta": { "request_id": "req_...", "api_version": "2026-05-12" }
}
\`\`\`

Wait up to 60s, then check the receiver logs. The delivery should arrive with:

\`\`\`
POST /gnubok HTTP/1.1
Content-Type: application/json
X-Gnubok-Signature: t=1715797800,v1=2f5c...
X-Gnubok-Event: webhook.test
X-Gnubok-Delivery: wh_dlv_...
X-Gnubok-Api-Version: 2026-05-12

{"id":"wh_dlv_...","type":"webhook.test","api_version":"2026-05-12","created":1715797800,"data":{"object":{"hello":"from Accounted","tested_at":"2026-05-15T12:00:00Z"}},"previous_attributes":null}
\`\`\`

If your receiver returns 2xx, the delivery moves to \`delivered\`. If it returns 4xx (other than 410) or 5xx, it goes to \`failed\` and retries on the schedule \`1m / 5m / 30m / 2h / 12h / 24h / 48h\`.

## 4. Inspect the delivery

\`\`\`bash
curl "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/webhooks/$WEBHOOK_ID/deliveries?delivery_id=$DELIVERY_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

Response carries the captured response status and body (truncated to 4 KB), which is invaluable when debugging a 4xx from the receiver:

\`\`\`json
{
  "data": [{
    "id": "wh_dlv_...",
    "event_type": "webhook.test",
    "status": "delivered",
    "attempts": 1,
    "next_attempt_at": "2026-05-15T12:00:00Z",
    "response_status": 200,
    "response_body": "ok",
    "error": null,
    "request_id": "whdel_...",
    "created_at": "2026-05-15T12:00:00Z",
    "delivered_at": "2026-05-15T12:00:01Z"
  }]
}
\`\`\`

## 5. Drive a real event

Now mark a real invoice paid (or use any of the [event-emitting endpoints](/docs/api/webhooks#event-types)). The webhook handler picks up the emission and enqueues a delivery within the same request cycle.

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/invoices/$INVOICE_ID/mark-paid" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" \\
  -d '{ "payment_date": "2026-05-22", "payment_amount": 12000.00 }'
\`\`\`

The next dispatcher tick (within 60s) delivers an \`invoice.paid\` event to your receiver carrying the full invoice payload + payment details.

## Idempotency on the receiver side

Deliveries are at-least-once. The same \`X-Gnubok-Delivery\` may arrive twice when the network drops a 200 response or your receiver times out after processing. Build idempotency around that header:

\`\`\`javascript
// Pseudo-code — adapt to your storage layer.
async function handleEvent(event) {
  const inserted = await db.processedDeliveries.insertIfMissing({
    delivery_id: event.id,
    event_type: event.type,
    received_at: new Date(),
  })
  if (!inserted) {
    console.log('duplicate delivery, skipping', event.id)
    return
  }
  await processBusinessLogic(event)
}
\`\`\`

This pattern: a unique constraint on \`delivery_id\`, an INSERT-on-conflict-do-nothing, and short-circuit when nothing was inserted. Every Accounted delivery passes through that gate at most once even if the dispatcher retries.

## Replaying a dead delivery

When a delivery exhausts its retries it's marked \`dead\`. After fixing the receiver, replay individual deliveries with:

\`\`\`bash
curl -X POST "https://app.gnubok.se/api/v1/webhook-deliveries/$DELIVERY_ID/retry" \\
  -H "Authorization: Bearer gnubok_sk_test_..."
\`\`\`

The retry creates a fresh delivery row pointing at the same payload — the original audit row stays in place. Receivers see the same \`X-Gnubok-Delivery\` (the new row's id, not the original's), so the idempotency table needs no special handling.

## Auto-disable

After:
- HTTP 410 Gone from your receiver, OR
- HTTP 3xx redirect (refused to follow — SSRF policy), OR
- The webhook URL resolves to a private/loopback/link-local/cloud-metadata IP at dispatch time

…the webhook is automatically disabled (\`active=false\`, \`disabled_reason\` set). Re-enable with:

\`\`\`bash
curl -X PATCH "https://app.gnubok.se/api/v1/companies/$COMPANY_ID/webhooks/$WEBHOOK_ID" \\
  -H "Authorization: Bearer gnubok_sk_test_..." \\
  -H "Content-Type: application/json" \\
  -d '{ "active": true }'
\`\`\`

This clears \`disabled_at\` and \`disabled_reason\` but does NOT replay the deliveries that died while disabled — replay them individually with the retry endpoint.

## Common pitfalls

- **Re-serialising the body.** \`JSON.parse(rawBody); JSON.stringify(parsed)\` produces different bytes than Accounted sent. Always sign-check against the raw bytes.
- **Forgetting the timestamp window.** Without a \`t\` check, an attacker who captured one signed payload can replay it forever. 5 minutes is the recommended tolerance.
- **Returning 5xx for application errors.** A 5xx triggers full retries (~72h). If a payload is malformed-but-stable, return 200 and queue for internal investigation.
- **Treating \`failed\` as terminal.** \`failed\` rows will retry; only \`delivered\` and \`dead\` are terminal. Don't alert on \`failed\` — alert when retries exhaust to \`dead\`.
`
