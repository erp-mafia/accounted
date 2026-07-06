export const WEBHOOKS_MD = `# Webhooks

> Receive HMAC-signed POST notifications when state changes in Accounted: invoices paid, journal entries committed, periods locked, salary runs booked, AGI files generated. At-least-once delivery with exponential backoff over ~72 hours.

If you've used [Stripe webhooks](https://docs.stripe.com/webhooks), the model is identical: subscribe a URL to an event type, Accounted POSTs each event with a signed JSON body, your receiver returns 2xx to acknowledge. The signature header format and retry policy are the same. The event types are gnubok-specific.

## Lifecycle

1. **Register a receiver** with [\`POST /api/v1/companies/{companyId}/webhooks\`](/docs/api/reference/webhooks#post-webhooks). The response includes an HMAC signing secret returned **exactly once**: store it on the receiver side immediately. If you lose it, delete the webhook and create a new one.
2. **Accounted emits events** internally (e.g. an invoice is marked paid via the dashboard or another API call). The webhook handler enqueues a delivery row.
3. **The dispatcher cron runs every minute**, signs the payload with HMAC-SHA256, and POSTs to your URL with a 10-second timeout.
4. **Your receiver verifies the signature**, processes the event idempotently, and returns 2xx.
5. **Failed deliveries retry** at \`1m / 5m / 30m / 2h / 12h / 24h / 48h\` (7 retries, ~72 hours total). After all attempts the delivery is marked \`dead\`. HTTP 410 from your receiver short-circuits to \`dead\` immediately and **auto-disables** the webhook.

## Event types

The following event types are deliverable as webhooks. Subscribing to a type that requires elevated scope (\`salary_run.*\` and \`agi.*\` need \`payroll:read\`) returns \`INSUFFICIENT_SCOPE\` at registration time.

**Invoicing**
- \`invoice.created\`: draft invoice created
- \`invoice.sent\`: invoice marked sent (email delivered or external)
- \`invoice.paid\`: invoice fully paid
- \`credit_note.created\`: credit note issued

**AP / suppliers**
- \`supplier.created\`
- \`supplier_invoice.registered\`
- \`supplier_invoice.approved\`
- \`supplier_invoice.paid\`
- \`supplier_invoice.credited\`
- \`supplier_invoice.uncredited\`: credit reversal

**Customers**
- \`customer.created\`

**Bookkeeping**
- \`journal_entry.committed\`: voucher posted (immutable from this point)
- \`journal_entry.reversed\`: storno entry posted
- \`journal_entry.corrected\`: rättelse via \`correctEntry\` (BFL 5 kap 5 §)

**Transactions**
- \`transaction.categorized\`: bank transaction assigned an account + tax code
- \`transaction.reconciled\`: transaction matched to a posted entry

**Periods**
- \`period.locked\`: fiscal period closed for writes
- \`period.unlocked\`: fiscal period reopened
- \`period.year_closed\`: full year-end procedure complete

**Payroll** *(requires \`payroll:read\` scope alongside \`webhooks:manage\`)*
- \`salary_run.created\`
- \`salary_run.approved\`
- \`salary_run.booked\`: journal entries posted
- \`agi.generated\`: AGI XML produced

**Documents**
- \`document.uploaded\`

## Payload shape

Every delivery wraps the event in a Stripe-style envelope:

\`\`\`json
{
  "id": "wh_dlv_a8f1...",
  "type": "invoice.paid",
  "api_version": "2026-05-12",
  "created": 1715797800,
  "data": {
    "object": {
      "invoice": { "id": "...", "invoice_number": "2026-0042", "total": 12500.00, ... },
      "paymentAmount": 12500.00,
      "paymentDate": "2026-05-15",
      "companyId": "..."
    }
  },
  "previous_attributes": null
}
\`\`\`

- \`id\` matches the \`webhook_delivery_id\` you can poll at [\`GET /webhooks/{webhookId}/deliveries\`](/docs/api/reference/webhooks#get-deliveries).
- \`api_version\` is the version pinned to your webhook at creation time. Payload shapes for *your* webhook will not change until you explicitly upgrade.
- \`previous_attributes\` carries the prior values of any fields that changed on update-style events (e.g. \`invoice.paid\` carries the prior invoice state). \`null\` for create-style events.

## Request headers

Every outbound POST carries:

\`\`\`
POST /your-receiver-url HTTP/1.1
Content-Type: application/json
User-Agent: gnubok-webhook/1
X-Gnubok-Signature: t=1715797800,v1=2f5c...
X-Gnubok-Event: invoice.paid
X-Gnubok-Delivery: wh_dlv_a8f1...
X-Gnubok-Api-Version: 2026-05-12
X-Request-Id: whdel_a8f1...
\`\`\`

The \`X-Gnubok-Delivery\` header is the canonical correlation id: log it on receipt and use it to deduplicate retries (deliveries are at-least-once, so the same delivery id may arrive more than once after a network blip).

## Verifying signatures

The signature header has the format \`t=<unix-seconds>,v1=<hex-HMAC-SHA256>\`. The signed payload is \`\${t}.\${rawBody}\`: the timestamp is included so receivers can implement a replay window (we recommend rejecting deliveries with \`t\` more than 5 minutes old).

You **must** verify the signature on every delivery before processing it. Without verification, anyone who learns your URL can forge events.

### Node.js

\`\`\`javascript
import crypto from 'node:crypto'
import express from 'express'

const app = express()
const SECRET = process.env.GNUBOK_WEBHOOK_SECRET // whsec_...

// Important: capture the RAW body before any JSON parsing: the signature
// is computed against the exact bytes Accounted sent, not a re-serialised JSON.
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sigHeader = req.header('x-gnubok-signature') ?? ''
    const rawBody = req.body.toString('utf8')

    if (!verifySignature(rawBody, sigHeader, SECRET)) {
      return res.status(400).send('invalid signature')
    }

    const event = JSON.parse(rawBody)
    // Idempotency: process the delivery id once.
    if (alreadyProcessed(event.id)) return res.status(200).send('ok')
    handleEvent(event)
    return res.status(200).send('ok')
  },
)

function verifySignature(body, header, secret) {
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2)),
  )
  const t = Number.parseInt(parts.t, 10)
  const v1 = parts.v1
  if (!t || !v1) return false

  // Reject deliveries older than 5 minutes: replay protection.
  const ageSec = Math.floor(Date.now() / 1000) - t
  if (Math.abs(ageSec) > 300) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(\`\${t}.\${body}\`)
    .digest('hex')

  // Constant-time comparison.
  const expectedBuf = Buffer.from(expected, 'hex')
  const actualBuf = Buffer.from(v1, 'hex')
  if (expectedBuf.length !== actualBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, actualBuf)
}
\`\`\`

### Python

\`\`\`python
import hmac
import hashlib
import json
import os
import time
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["GNUBOK_WEBHOOK_SECRET"].encode("utf-8")  # whsec_...

@app.post("/webhook")
def webhook():
    raw_body = request.get_data()  # bytes: must be the raw request body
    sig_header = request.headers.get("X-Gnubok-Signature", "")

    if not verify_signature(raw_body, sig_header, SECRET):
        abort(400, "invalid signature")

    event = json.loads(raw_body)
    if already_processed(event["id"]):
        return "", 200
    handle_event(event)
    return "", 200


def verify_signature(body: bytes, header: str, secret: bytes) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    try:
        t = int(parts["t"])
        v1 = parts["v1"]
    except (KeyError, ValueError):
        return False

    # Replay protection: 5-minute window.
    if abs(int(time.time()) - t) > 300:
        return False

    signed = f"{t}.".encode("utf-8") + body
    expected = hmac.new(secret, signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)
\`\`\`

### Common pitfalls

- **Using parsed JSON instead of raw bytes.** Re-serialising the body (\`JSON.stringify(req.body)\`) produces different bytes than Accounted sent: the signature won't match. Capture the raw body before any framework parses it.
- **Forgetting the timestamp window.** Without checking \`t\`, an attacker who captured one signed payload can replay it forever. 5 minutes is our recommended window; tighten if your clock skew is small.
- **Treating retries as duplicates of failure.** Retries arrive when *we* didn't get a 2xx. A 200 response that arrives slowly may not reach us in time and we'll retry: your receiver sees the same \`X-Gnubok-Delivery\` twice. Idempotency is on you.
- **Returning 5xx for application errors.** A 5xx triggers the full retry policy (~72h of attempts). If your handler hit an application bug that won't resolve on retry, return 200 and queue the failure for internal investigation; only return 5xx for genuinely transient problems.
- **Missing \`redirect: 'error'\`-style refusal at receiver level.** If your receiver follows redirects, an attacker who can MITM the response could redirect re-tries to a malicious URL. Modern HTTP clients refuse redirects by default for POST; verify yours does.

## Delivery debugging

Use [\`GET /api/v1/companies/{companyId}/webhooks/{webhookId}/deliveries\`](/docs/api/reference/webhooks#get-deliveries) to list the recent delivery history for a webhook: every row has the response status, response body (truncated to 4 KB, only \`text/plain\` and \`application/json\` content types persisted), error message, and current state (\`pending\` / \`in_flight\` / \`delivered\` / \`failed\` / \`dead\`).

To replay a \`dead\` or \`delivered\` delivery, call [\`POST /api/v1/webhook-deliveries/{deliveryId}/retry\`](/docs/api/reference/webhooks#post-retry). The retry creates a fresh delivery row pointing at the same payload: the original audit row stays in place. Receivers must be idempotent on the \`X-Gnubok-Delivery\` header.

To send a synthetic test event without driving real state, call [\`POST /webhooks/{webhookId}/test\`](/docs/api/reference/webhooks#post-test). The dispatcher delivers a \`webhook.test\` event with a static payload on the next per-minute tick.

## Auto-disable behaviour

The dispatcher disables a webhook (sets \`active=false\` + \`disabled_reason\`) and stops attempting delivery when:

- The receiver returns **HTTP 410 Gone**: explicit "stop sending"
- The receiver returns **HTTP 3xx redirect**: refusing to follow redirects to internal IPs is a security policy; a stable receiver should not return 3xx
- The webhook URL **resolves to a private/loopback/link-local/cloud-metadata IP** at dispatch time (DNS rebinding refusal)

Re-enable with [\`PATCH /webhooks/{webhookId}\`](/docs/api/reference/webhooks#patch-webhooks) setting \`active: true\`. This clears \`disabled_at\` + \`disabled_reason\` but does NOT replay the deliveries that died while disabled: replay them individually with the retry endpoint.

## Audit + retention

Webhook delivery rows are *behandlingshistorik* (a system-event log) per BFNAR 2013:2 kap 8 §: they are immutable once they reach a terminal state (\`delivered\` or \`dead\`) so the audit trail of who-was-notified-when stays intact. The underlying *räkenskapsinformation* (the verifikation, the faktura, the AGI XML itself) lives in its own table with its own BFL 7 kap retention: webhook delivery rows are NOT räkenskapsinformation and the 7-year retention applies to the underlying record, not to the delivery envelope.

For accounting-event delivery rows (\`journal_entry.*\`, \`period.*\`, \`salary_run.booked\`, \`agi.generated\`, \`invoice.paid\`, \`supplier_invoice.paid\`), Accounted keeps the delivery rows for 7 years. **This is a voluntary operational audit-trail policy Accounted chose because the duration aligns conveniently with BFL 7 kap retention on the underlying records: it is NOT itself a statutory obligation.** The 7-year statutory retention under BFL 7 kap 1 § applies to the underlying verifikation / faktura / AGI XML in its own table, not to the delivery envelope. The integrator's own retention obligations likewise attach to the underlying records you receive (and any local copies you persist), not to the delivery-row metadata.

Deleting a webhook does not delete its delivery history; the FK is \`ON DELETE SET NULL\` so the audit trail survives.
`
