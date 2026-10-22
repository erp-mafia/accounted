# Kivra integration reference

Researched 2026-10-19 from Kivra's public developer documentation, OpenAPI specs and partner pages. This is an engineering reference for two features:

- **(A) RECEIVE**: pull documents that arrive in a customer's Kivra Business (Kivra Företag) mailbox into our document inbox, using Kivra's **Partner API** ("PAPI").
- **(B) SEND**: deliver our customers' outgoing invoices (and possibly letters and salary slips) to recipients' Kivra mailboxes, using Kivra's **Tenant API** (also called the sender API), with one Kivra tenant per sending customer.

This integration is Accounted's own code, built on Kivra's public developer documentation. It is not an official Kivra product, and Kivra does not provide support for it or answer for its security.

Statements are marked **[docs]** when they come straight from Kivra's documentation or OpenAPI specs, and **[inferred]** when they are our reading of it or a design suggestion. This file contains no credentials, client IDs, secrets or tenant keys, and none may ever be added to it.

Canonical machine-readable specs (OpenAPI 3.1):

- Partner API: https://developer.kivra.com/starlight/openapi/partner-api.yaml
- Tenant API: https://developer.kivra.com/starlight/openapi/tenant-api.yaml
- Legacy combined bundle (has the long prose intro, the changelog and the full error table): https://developer.kivra.com/swagger.bundle.yml
- Official error code list (MIT): https://github.com/kivra/kivra-api-errors/blob/main/api-errors.json

---

## 1. Overview

| | Partner API (PAPI) | Tenant API |
|---|---|---|
| Our use case | (A) read customers' company inboxes | (B) send as our customers |
| Who grants access | The **company** activates an integration with us inside Kivra | Kivra provisions our **client**; we create or join one **tenant** per sending customer |
| Availability | Not generally available; Kivra enables it per partner [docs] | Tenant creation by API only for use cases agreed with Kivra [docs] |
| Credentials | Separate `client_id`/`client_secret` from the Tenant API [docs] | Own `client_id`/`client_secret` |
| Host | Same host as Tenant API | Same host as Partner API |
| Event delivery | Webhooks (`integration.created`, `content.created`, `integration.deleted`), HMAC signed | Payment webhooks only (Standard Webhooks signing) |

Terminology traps [docs]:

- In the Partner API, **partner** means us: a third party (accounting/ERP) that reads a company inbox.
- In the Tenant API, **partner** means a client that sends on behalf of another tenant (delegated sending). Unrelated to PAPI. We are a "partner" in both senses.
- **Client**: the OAuth identity (`client_id`). **Tenant**: the sender identity shown to recipients, identified by `tenantKey`. One client can act for many tenants.
- **Company**: a legal entity with a Kivra Business inbox, identified by a `key` (PAPI `company_key`) and a Swedish VAT number. **User**: a private person, identified by personnummer (`ssn`) or verified email.
- **Content**: one inbox item (letter, invoice, scanned mail, email). **Part**: one file inside a content.

How the two APIs connect [docs]: content a tenant sends with type `accounting.invoice` (structured invoice data next to the PDF) is surfaced to the receiving company's connected accounting system through the PAPI `accounting` object. Kivra announced this on 2026-10-14 with Fortnox as the first receiving system. The Tenant API also has `companymatch/vatnr_with_active_partner_integration` to find recipient companies that have some PAPI integration active.

Other Kivra APIs that are out of scope here: the **Legal API** (self-onboarding of senders, see 5.2) and the **Receipt API** (POS receipts).

Sources: https://developer.kivra.com/starlight/docs/partner-api/getting-started/overview/ , https://developer.kivra.com/starlight/docs/tenant-api/getting-started/overview/ , https://kivra.se/en/business/partnersite/current

---

## 2. Environments and base URLs

| Environment | API base URL | Recipient web login |
|---|---|---|
| Sandbox | `https://sender.sandbox-api.kivra.com` | `https://sandbox-accounts.kivra.com/register` (register a fictional test person with the SSN and activation code Kivra supplies) |
| Production | `https://sender.api.kivra.com` | `https://accounts.kivra.com` |

[docs]

- Sandbox and production are fully separate: different credentials, tenants, companies, content and webhook registrations. Nothing carries over.
- Sandbox is not for volume or capacity tests, has no availability guarantee, and may run newer builds than production.
- Use only fictional recipients and test documents in sandbox; never real personal data.
- Tenant icons are public at `https://sandbox-static.kivra.com/img/tenant/{tenantKey}/icon.png` and `https://static.kivra.com/img/tenant/{tenantKey}/icon.png`.
- Only HTTPS. Plain HTTP is redirected.
- URL shape: `https://sender.{api|sandbox-api}.kivra.com/{version}/...`. Versions are per endpoint (`v1`, `v2`, `v3` coexist). The auth endpoint is version independent.
- Breaking changes are announced on https://kivrastatus.se at least 6 months ahead. Subscribe to it.
- Every response carries `x-correlation-id`; include it in support requests to `avsandare.support@kivra.com`.
- Access: email `avsandare.support@kivra.com` with company name, org number, technical contact and the services wanted; Kivra answers within about one workday with sandbox credentials, a tenant key, a fictional SSN and an activation code.

Sources: https://developer.kivra.com/starlight/docs/partner-api/getting-started/environments/ , https://developer.kivra.com/starlight/docs/tenant-api/getting-started/environments/ , https://kivra.se/en/business/for-developers/introduction/sandbox , https://kivra.se/en/business/for-developers/introduction/production , swagger.bundle.yml intro

---

## 3. Authentication (both APIs)

OAuth 2.0 client credentials. One token endpoint for both APIs. [docs]

```
POST {base}/v1/auth
Authorization: Basic base64("<client_id>:<client_secret>")   # no trailing newline when encoding
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```

Optional extra form field `scope` requests a narrower token (see below).

Response `200` (schema `TokenResponse`; `scope` and `state` appear in examples but not in the schema):

```json
{
  "access_token": "<opaque>",
  "token_type": "bearer",
  "expires_in": 28800,
  "scope": "<granted scope>",
  "state": ""
}
```

- `400` invalid body, `401` invalid credentials.
- Use as `Authorization: Bearer <access_token>` on every call.
- Tenant API tokens live 8 hours (`expires_in: 28800`). The Partner API docs only say to honour `expires_in`. Cache and reuse; refresh shortly before expiry; do not fetch a token per request. [docs]
- Invalid or expired token gives `401` (error code `40015 Invalid Token` or `401xx`). [docs]

Scopes [docs]:

- Format `<methods>:<path>` where methods are lower case and comma separated, and the path starts with `kivra` with `.` instead of `/`. Example: `post:kivra.v1.tenant.{tenantKey}.content`, `get,put:kivra.v2.tenant.{tenantKey}.name`.
- Wildcards: `*` any keyword at the current level, `**` current level and recursively.
- A client can mint a reduced-scope token (for example only "send content for tenant X") by passing `scope=...` on `/v1/auth`. Useful if a worker should only be able to send for one customer. [docs; usefulness inferred]
- The Tenant API token covers all tenants in the client's scope. After **creating a tenant** or getting a **request_access** accepted, request a new token: the new tenant is not in old tokens. [docs]
- The Partner API token identifies only our client. Which companies we can read is decided per company by its integration; requests for a company without an active integration are rejected even with a valid token. [docs]
- v3 Partner API operations declare no specific scope; v1 Partner operations declare scopes like `get:kivra.v1.partner.company` and `get:kivra.v1.partner.company.{companyKey}.**`. [docs]

Keep credentials server side only (Vercel env / secrets store). Never in browser code, repos or logs. [docs]

Sources: https://developer.kivra.com/starlight/docs/partner-api/getting-started/authentication/ , https://developer.kivra.com/starlight/docs/tenant-api/getting-started/authentication/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/create-access-token/ , swagger.bundle.yml "API - Authentication"

---

## 4. Partner API (RECEIVE, use case A)

### 4.1 Access model and onboarding

Prerequisites on the customer side [docs]:

- The company needs a **Kivra Business** (Kivra Företag) account. Supported company forms: aktiebolag, handelsbolag and kommanditbolag (with a natural person signatory), ekonomiska föreningar including BRF. **Not supported: enskild firma and ideella föreningar.** A sole trader uses their private Kivra, which the Partner API cannot read.
- Registering needs a private Kivra account, Mobile BankID, the company VAT number, and a person who is a signatory (firmatecknare). Signatories can share access with others (accountants) under Settings.
- PAPI `CompanyType` is `company` (Bolagsverket registry, includes ekonomiska föreningar) or `riksidrottsförening`.

Activation [docs]:

1. A user allowed to act for the company opens company settings in Kivra, picks us from the list of partners and activates the integration. Kivra then sends `integration.created`.
2. From then on we may read that company's inbox until the company deactivates the integration in Kivra, which triggers `integration.deleted`. After that every request under that `company_key` fails; stop calling it.
3. We cannot grant ourselves access.

Partner adapted onboarding [docs, partly inferred]: Kivra's partner news (2024-11-01) says partners can let customers sign up for Kivra Företag from inside the partner's system with the integration activated automatically, via a customized onboarding arranged with Kivra's partner team. Kivra gives each partner its own onboarding link for this. It is a partner-only flow and not in the public docs, so the link is deployment configuration (`KIVRA_ONBOARDING_URL`), never code or documentation. Either way, the only signal we get is the `integration.created` webhook (or polling `GET /v3/partner/company`).

Fortnox's version of this flow, for reference: activation runs from inside Fortnox by a signatory logged in with BankID, and removal is "Ta bort koppling" in Fortnox. Other systems with live PAPI integrations: Spiris, Briox, Bflow, Reda, Accountec. [docs, third party]

If a company closes its Kivra Business account, it keeps access for 45 days, after which the account and all its content is deleted. [docs] Implication: Kivra is not our archive. Copy every document we need into our own 7-year storage when we import it. [inferred]

Sources: https://developer.kivra.com/starlight/docs/partner-api/integration-guide/ , https://kivra.se/en/business/partnersite/current , https://kivra.se/en/business/kivra-business (FAQ) , https://kivra.se/en/business/kivra-business/get-started , https://kivra.se/en/business/kivra-business/merging-service/fortnox , https://support.fortnox.se/produkthjalp/foretagsbrevlada/foretagsbrevlada-kom-igang

### 4.2 Learning which companies connected, and mapping them to our companies

Push [docs]: the `integration.created` webhook carries `data.company_key` and `data.vat_number`.

Pull [docs]:

| Method | Path | Notes |
|---|---|---|
| GET | `/v3/partner/company` | All companies with an active integration to us. Query `vat_number` (array) filters; `field` (array) selects returned properties. Returns `BaseCompany[]`: `key`, `name`, `type`, `vat_number`. |
| GET | `/v3/partner/company/{companyKey}` | `FullCompany`: `key`, `name`, `type`, `vat_number`, `created_at`, `email` (the company's `xxxxxxxxx@kivramail.com` address or `""`), `scanning_address`, `scanning_fallback_address`, `services` (`email`, `scanning`, `kivra` (always true), `minameddelanden`, `interpreter` (deprecated, always false)). |
| GET | `/v1/partner/company?vat_number=SE...` | Legacy lookup, returns `{ "key": "..." }`; empty list if no such company or no access. |

Array query parameter serialization is not specified; repeated keys (`?vat_number=A&vat_number=B`) is the usual OpenAPI default. [inferred]

Identifier formats [docs]:

- `company_key` and `content_key`: `^[0-9]{10}[a-f0-9]{32}$` (42 chars, a 10 digit timestamp prefix plus 32 hex).
- `vat_number`: `^SE[0-9]{10}01$`. The 10 digits are the organisationsnummer. Map to our company by stripping `SE` and `01` and formatting `NNNNNN-NNNN`. [inferred]

Mapping design [inferred]:

- Keep a table `kivra_partner_integrations(company_id, kivra_company_key, vat_number, status, activated_at, deactivated_at)`.
- One org number can exist in more than one Accounted company (for example a firm's copy plus the client's own). Decide which Accounted company receives the documents; the cleanest is to bind the integration to the company that started the onboarding (session state before redirect to Kivra) and fall back to org number matching only when exactly one company matches.
- Treat `integration.deleted` as authoritative and stop all calls for that key.

Sources: https://developer.kivra.com/starlight/docs/api/partner/operations/list-companies/ , https://developer.kivra.com/starlight/docs/api/partner/operations/get-company-information/ , https://developer.kivra.com/starlight/docs/api/partner/operations/find-company/ , partner-api.yaml

### 4.3 Endpoint summary

Use v3. v1 is legacy but still documented. [docs]

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth` | Token (section 3) |
| GET | `/v3/partner/company` | List connected companies |
| GET | `/v3/partner/company/{companyKey}` | Company details |
| GET | `/v3/partner/company/{companyKey}/content` | List inbox (`BaseContentMetadata[]`) |
| GET | `/v3/partner/company/{companyKey}/content/{contentKey}` | Full metadata (`FullContentMetadata`) |
| GET | `/v3/partner/company/{companyKey}/content/{contentKey}?part={n}` | Download file part `n` (1-based) |
| PATCH | `/v3/partner/company/{companyKey}/content/{contentKey}` | Set `labels.handled` / `labels.viewed` |
| GET | `/v1/partner/company?vat_number=` | Legacy: find company key |
| GET | `/v1/partner/company/{companyKey}/content` | Legacy inbox list (`key`, `sender`, `sender_name`, `created_at`, `subject`, `status` = `read`/`unread`) |
| GET | `/v1/partner/company/{companyKey}/content/{contentKey}` | Legacy metadata with deprecated `payment` object and `parts[].key` or inline `parts[].body` |
| GET | `/v1/partner/company/{companyKey}/content/{contentKey}/file/{fileKey}/raw` | Legacy binary download |
| POST | `/v1/partner/company/{companyKey}/content/{contentKey}/{status}` | Legacy status: `paid`, `unpaid`, `view`, `unview`; empty JSON body; `204` |

### 4.4 Listing content

```
GET /v3/partner/company/{companyKey}/content?handled=false
Authorization: Bearer <token>
```

Query parameters [docs]: `handled` (boolean), `viewed` (boolean), `field` (array of property names to return).

Response `200`: JSON array of `BaseContentMetadata` (fields in 4.5 minus `payment_options`, `accounting`, `references`, `sender_contact_info`, `interpreted_fields`).

**No pagination, cursor, `since` or date filter is documented** for this endpoint. [docs] Treat it as returning the full (filtered) inbox and diff on `key` against what we already imported. Watch response size for large inboxes and ask Kivra about limits. [inferred]

Sources: https://developer.kivra.com/starlight/docs/api/partner/operations/list-content-in-the-company-inbox/

### 4.5 Content metadata

```
GET /v3/partner/company/{companyKey}/content/{contentKey}
Authorization: Bearer <token>
```

Response `200` `FullContentMetadata` (example values from Kivra's integration guide):

```json
{
  "key": "1756718042a9813e08f783496382b0bff743ec34ae",
  "type": "invoice",
  "origin": "kivra",
  "subject": "Faktura 12345",
  "created_at": "2026-09-01T00:00:00Z",
  "received_at": "2026-09-01T09:14:02Z",
  "transaction_at": "2026-09-01T00:00:00Z",
  "receiver_name": "Cornelias Café AB",
  "receiver_vat_number": "SE442005921601",
  "sender_name": "Lenas Konditori AB",
  "sender_vat_numbers": ["SE442005921601"],
  "sender_icon_url": "https://sandbox-static.kivra.com/img/tenant/<tenantKey>/icon.png",
  "sender_contact_info": null,
  "references": null,
  "labels": {
    "governmental": false, "handled": false, "interpreted": false,
    "reminder": false, "trashed": false, "viewed": false
  },
  "interpreted_fields": [],
  "parts": [
    {
      "content_type": "application/pdf",
      "name": "faktura-12345.pdf",
      "sha256": "f6c2...231f",
      "size": 48213,
      "url": "https://sender.sandbox-api.kivra.com/v3/partner/company/<companyKey>/content/<contentKey>?part=1"
    }
  ],
  "payment_options": [
    {
      "type": "bankgiro",
      "account": "5050-1055",
      "amount": 150000,
      "currency": "SEK",
      "vat_amount": null,
      "due_at": "2026-09-30T00:00:00Z",
      "reference": "123456789",
      "reference_type": "OCR",
      "description": "Total",
      "interpreted": false
    }
  ]
}
```

Field reference [docs]:

| Field | Type | Meaning |
|---|---|---|
| `key` | string | Content key |
| `type` | `invoice` \| `other` | Only two values on the receive side |
| `origin` | `kivra` \| `minameddelanden` \| `user` \| `physical` \| `email` | `kivra` sent by a Kivra sender; `minameddelanden` government mail; `user` uploaded by a company user; `physical` scanned paper (Business Plus); `email` sent to the company's kivramail address (Business Plus) |
| `subject` | string | Sender supplied title |
| `created_at` | date-time | Same as `transaction_at`, except for reminders where it is the reminder date |
| `received_at` | date-time | When Kivra received it |
| `transaction_at` | date-time or null | Invoice date for `invoice` (original invoice date for reminders); null for `other` or when unknown |
| `receiver_name`, `receiver_vat_number` | string | The receiving company |
| `sender_name` | string or null | Sender display name |
| `sender_vat_numbers` | string[] or null | Sender VAT numbers (`SE...01`), useful for supplier matching |
| `sender_icon_url` | url or null | Sender icon |
| `sender_contact_info` | object or null | `email_address`, `phone_number`, `url`, `logo_url`, `text` (all nullable) |
| `references` | object or null | `{ "our": string\|null, "your": string\|null }` (vår/er referens) |
| `labels` | object | `governmental`, `handled` (formerly "paid"), `reminder` (invoice is a reminder), `trashed`, `viewed`, `interpreted` (deprecated, always false) |
| `interpreted_fields` | string[] | Deprecated, always `[]` |
| `parts[]` | `PartMetadata` | `content_type`, `name`, `sha256` (may be null for content before early 2018), `size` (bytes), `url`, optional `responsive_body` (HTML) |
| `payment_options[]` | `PartnerPaymentOption` | See below |
| `accounting` | object, optional | Structured invoice data when the sender used `accounting.*` types (see below) |

`parts[].content_type` enum: `application/pdf`, `text/html`, `text/plain`, `image/jpeg`, `image/gif`, `image/png`, `text/calendar`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/vnd.openxmlformats-officedocument.wordprocessingml.template`. [docs]

`payment_options[]` (all nullable except `interpreted`) [docs]:

| Field | Type | Notes |
|---|---|---|
| `type` | string | Account type, example `bankgiro`; full enum not documented |
| `account` | string | Destination account, example `5050-1055` |
| `amount` | integer | **In öre** (150000 = 1 500,00 SEK) |
| `vat_amount` | integer | VAT in öre, if known |
| `currency` | string | Example `SEK` |
| `due_at` | date-time | Due date |
| `reference` | string | OCR or other payment reference |
| `reference_type` | string | Example `OCR`; full enum not documented |
| `description` | string | Option label |
| `interpreted` | boolean | Deprecated, always false |

`accounting` (structured invoices; all strings) [docs]: `invoice_type` (the sender's `accounting.*` type), `invoice_number`, `original_invoice_number`, `invoice_date`, `due_date`, `currency`, `total_amount_due`, `total_amount_tax_exclusive`, `total_amount_tax_inclusive`, `total_vat_amount`, `rounding_amount`, `bankgiro`, `plusgiro`, `iban`, `bic`, `payment_reference` (object; on the send side it is `{ "value": "...", "reference_type": "ocr" | "unstructured" }`), `buyer_reference`, `order_number`, `supplier_name`, `supplier_organisation_number`, `supplier_vat_number`, `supplier_address_street`, `supplier_address_postal_code`, `supplier_address_city`. Amounts here are decimal strings in currency units (for example `"1250.00"`), unlike `payment_options` which uses integer öre. [docs]

Sources: https://developer.kivra.com/starlight/docs/api/partner/operations/get-a-specific-company-content/ , https://developer.kivra.com/starlight/docs/api-reference/partner-schemas/ , partner-api.yaml

### 4.6 Downloading files

```
GET /v3/partner/company/{companyKey}/content/{contentKey}?part=1
Authorization: Bearer <token>
```

[docs]

- `part` is the 1-based index into `parts`. Simplest is to GET the ready-made `parts[n].url`.
- The response body is the raw file; `Content-Type` equals the part's `content_type`.
- Verify the download against `sha256` and `size`.
- Letters can arrive as `text/plain` or `text/html` parts and are downloaded the same way. HTML parts should be rendered sandboxed or converted; never trusted. [inferred]
- Legacy v1: `GET /v1/partner/company/{companyKey}/content/{contentKey}/file/{fileKey}/raw`, where text parts come inline as `parts[].body` instead of a `key`.

Sources: https://developer.kivra.com/starlight/docs/partner-api/integration-guide/ , https://developer.kivra.com/starlight/docs/api/partner/operations/get-raw-file/

### 4.7 Marking content handled or read

```
PATCH /v3/partner/company/{companyKey}/content/{contentKey}
Authorization: Bearer <token>
Content-Type: application/json

{ "labels": { "handled": true } }
```

[docs]

- Body allows only `labels.handled` and `labels.viewed` (`additionalProperties: false`). Both can be set back to `false`.
- Response `200` with the updated `FullContentMetadata`.
- These are the same flags the company's users see in Kivra ("hanterad", "läst"). Kivra suggests marking `handled` when our system has booked or paid the invoice so nobody pays it twice, and offering "mark as read/handled in Kivra" actions in our UI.
- There is no separate "fetched" or "ack" state for partners. Our own import bookkeeping must track what we already pulled. [docs; consequence inferred]

Sources: https://developer.kivra.com/starlight/docs/api/partner/operations/update-company-content-metadata/ , https://developer.kivra.com/starlight/docs/partner-api/integration-guide/

### 4.8 Webhooks (Partner API)

Registration [docs]: Kivra registers our HTTPS endpoint and gives us the signing secret during partner setup (contact Kivra Sender Success). Sandbox and production are registered separately. There is no self-service registration endpoint for PAPI webhooks.

Events [docs]:

| `event_type` | When | `data` |
|---|---|---|
| `integration.created` | A company activated the integration with us | `company_key`, `vat_number` |
| `content.created` | A connected company received content | `company_key`, `content_key`, `vat_number` |
| `integration.deleted` | The company deactivated the integration | `company_key`, `vat_number` |

Envelope [docs]:

```json
{
  "id": "event_3f62fc97907a4212af028c30f1ea1927",
  "event_created_at": 1788254042,
  "event_type": "content.created",
  "data_version": 1,
  "data": {
    "company_key": "1560774336a57b73569d594df5abad7fd2575c1070",
    "content_key": "1756718042a9813e08f783496382b0bff743ec34ae",
    "vat_number": "SE442005921601"
  }
}
```

- `id`: stable across retries; deduplicate on it.
- `event_created_at`: Unix seconds when the event happened (not when this attempt was sent).
- New fields may appear in `data` without a `data_version` bump; ignore unknown fields. Breaking changes bump `data_version`.
- Events carry keys only; fetch metadata and files with the API.

Signature verification [docs]:

```
X-KIVRA-TIMESTAMP: <unix seconds of this delivery attempt>
X-KIVRA-SIGNATURE: v1=<hex HMAC-SHA256>      (one header per active secret during rotation)
```

1. Read `t` from `X-KIVRA-TIMESTAMP`; reject if outside our tolerance window (replay protection).
2. Message = `t + ":" + rawBody` (the exact raw request bytes).
3. Expected = hex(HMAC-SHA256(secret, message)).
4. Compare in constant time against the hex after `v1=` in **every** `X-KIVRA-SIGNATURE` header; accept if any matches.

Acknowledgement and retries [docs]: respond `200 OK` once the event is durably stored; anything else is retried with growing delays "for a long time". Delivery is at least once and may be late. Acknowledge first, process asynchronously.

Polling fallback [inferred]: a periodic job calling `GET /v3/partner/company` (to catch missed `integration.*` events) and `GET /v3/partner/company/{key}/content` diffed on `key` covers missed or delayed webhooks. Kivra's 2025-05-05 partner news positions webhooks as the replacement for polling, so polling is allowed but should be infrequent. Whether `content.created` fires for content that already existed when the integration was activated is not documented; do a backfill list on `integration.created`. [inferred]

Sources: https://developer.kivra.com/starlight/docs/partner-api/webhooks/ , https://developer.kivra.com/starlight/docs/api/partner/webhooks/webhook-content-created/ , https://developer.kivra.com/starlight/docs/api/partner/webhooks/webhook-integration-created/ , https://developer.kivra.com/starlight/docs/api/partner/webhooks/webhook-integration-deleted/ , swagger.bundle.yml tag "Partner API v3"

### 4.9 Limits and errors (Partner API)

- No Partner API specific rate limit, pagination or payload limit is documented. The generic `429` (`42900 Too Many Requests`) and `413` behaviour applies. [docs]
- Resources we may not see return a describing status or `404` (Kivra uses `404` when we may not even know whether the object exists). [docs]
- Error body format is shared with the Tenant API (see 5.11).

---

## 5. Tenant API (SEND, use case B)

### 5.1 Concepts that change behaviour [docs]

- **Opt-out model**: every Kivra user and company receives from every sender by default; a recipient can block a specific tenant. Matching is per tenant.
- **Active users**: a person must log in at least once every 12 months to keep showing up in matching.
- **Dormant**: recipients unreachable by email/SMS are dormant. Dormant recipients do **not** show up in matching, but content sent to them is still delivered.
- **Grace period**: when a recipient deactivates or blocks a tenant there is a 10 day grace period during which they no longer match but content is still delivered.
- **Retained content**: for recipients not (yet) in Kivra; only for some types (5.8).
- The tenant name and icon are what the recipient sees. The legal company identity of the tenant uses the registered name and VAT number.

Sources: swagger.bundle.yml intro ("Terminology", "Opt-out"), https://developer.kivra.com/starlight/docs/tenant-api/getting-started/tenants/

### 5.2 Tenant lifecycle (one tenant per sending customer)

Tenant management by API is meant only for clients that send on behalf of other tenants (platforms onboarding their customers) and must be agreed with Kivra first. [docs]

| Method | Path | Purpose | Responses |
|---|---|---|---|
| POST | `/v2/tenant` | Create tenant, or add an existing one to our scope | `201` created, `200` existing tenant found and added to our scope, `409` (code `40915`) VAT number belongs to a tenant outside our scope |
| GET | `/v2/tenant` | List tenants our client may manage; optional `?orgnr=SE...01` | `200` `[{ "key": "..." }]` |
| GET | `/v2/tenant/{tenantKey}` | Tenant details | `200` `Tenant_v2` |
| PUT | `/v2/tenant/{tenantKey}/name` | Change display name; body `{ "name": "..." }`; recipients see it after their next delivery | `200` |
| POST | `/v2/tenant/{tenantKey}/company_id` | Add a legal identity; body `{ "company_id": { "name": "...", "orgnr": "SE...01" } }` | `204`, `409` |
| DELETE | `/v2/tenant/{tenantKey}/company_id/{orgNr}` | Remove a legal identity (`orgNr` is the VAT number) | `204` |
| POST | `/v2/tenant/{tenantKey}/icon` | Set icon; body `{ "file": { "name": "...", "data": "<base64 png>", "content_type": "image/png" } }` | `204` |
| POST | `/v2/tenant/request_access` | Ask to share a tenant owned by another client; body `{ "vat_number": "SE...01" }` | `201` `RequestAccess`, header `kivra-objkey` = requestKey |
| GET | `/v2/tenant/request_access/{requestKey}` | Poll until `status` is `accepted` or `rejected` (starts `pending`) | `200` |

Create request [docs]:

```json
POST /v2/tenant
{
  "name": "Example Energy",
  "company_id": [
    { "name": "Example Energy AB", "orgnr": "SE442005920801" }
  ]
}
```

- `name`: public sender name in the inbox (can be a brand). `company_id[].name`: legal name as registered at Bolagsverket. `company_id[].orgnr`: the **VAT number** format `SE` + 10 digits + `01`, despite the field name.
- Response body is `Tenant_v2`; the tenant key is in response header `kivra-objkey` (and `location` has the object URL). Read-only fields returned: `edit_security_level` (25 or 50), `groups`, `visibility` (`visible`/`hidden`), `created_at`, `created_by` (our client id), `status`, `class`.
- The new tenant is in our scope immediately but only in **new** tokens: re-authenticate before using it.
- `409` example `long_message` names the existing tenant and its key. Then use `request_access`; access may be granted asynchronously by the other client or Kivra. A tenant can be shared between clients (for example one client sends invoices and another payslips). Re-identical requests return the same object with updated status.
- Icon rules: square PNG with alpha channel (PNG32), 256 to 512 px per side, max about 134 kB base64 (about 100 kB raw). Errors `40030` (size) and `40031` (no alpha). Leave whitespace around the logo.

Legal onboarding of senders [docs]: Kivra has a separate **Legal API** for platforms that self-onboard other senders in an automated customer journey (Kivra names accounting, payroll and invoicing software as the typical fit). It makes sure each sender has accepted Kivra's legal terms. It runs on Salesforce with an OAuth password grant and its own credentials (test: `test.salesforce.com`, prod: `login.salesforce.com`), a request header `clientId` equal to the Tenant API client id we create tenants with, and a Swagger file (`kivraLegalApi_v1.json` / `test_kivraLegalApi_v1.json`) that Kivra only sends on request. Without it, each sender signs a manual agreement with Kivra. A third-party integrator (InExchange) collects the customer's acceptance of Kivra's data processing agreement and general terms as booleans at registration, which suggests the Legal API captures the same. [docs + third party; Legal API shape not public]

Sources: https://developer.kivra.com/starlight/docs/tenant-api/getting-started/tenants/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/create-tenant-v2/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/request-access/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/provide-icon/ , https://kivra.se/en/business/for-developers/introduction/tenant-onboarding , https://kivra.se/en/business/for-developers/introduction/legal-onboarding , https://api.inexchange.com/docs/Send%20Invoice/DeliveryMethods/B2C/Kivra

### 5.3 Recipient matching

All matching is per tenant and bulk: send a list, get back the subset that is eligible for this tenant. Empty list if none match. [docs]

| Method | Path | Identifier | Notes |
|---|---|---|---|
| POST | `/v2/tenant/{tenantKey}/usermatch/ssn` | personnummer `YYYYMMDDnnnn` (12 digits, with century) | Up to 10 MB (about 500 000 SSNs); `413` above |
| POST | `/v2/tenant/{tenantKey}/usermatch/verified_email` | verified email | Case insensitive; returned in the case we sent |
| POST | `/v2/tenant/{tenantKey}/companymatch/vatnr` | VAT `SE##########01` | Up to 10 MB; `413` above |
| POST | `/v2/tenant/{tenantKey}/companymatch/vatnr_with_active_partner_integration` | VAT | Only companies that also have an active PAPI integration (any partner). Not a full eligibility list. |
| GET | `/v1/tenant/{tenantKey}/company[?vat_number=]` | VAT | List or search eligible company recipients (`[{ "key": "", "vatnr": "SE..." }]`, `key` deprecated) |
| GET | `/v2/tenant/{tenantKey}/company` | VAT | Full list of eligible companies plus a `diff-id` response header; may require agreement |
| GET | `/v2/tenant/{tenantKey}/company/diff/{diffId}` | VAT | `{ "added": [{ "vatnr" }], "removed": [{ "vatnr" }] }` plus a new `diff-id`; chain expires 31 days after the initial full list; `404` when expired |

Request and response shape (all three POST match endpoints):

```json
POST /v2/tenant/{tenantKey}/usermatch/ssn
{ "list": ["YYYYMMDDNNNN", "YYYYMMDDNNNN"] }

200
{ "list": ["YYYYMMDDNNNN"] }
```

```json
POST /v2/tenant/{tenantKey}/companymatch/vatnr
{ "list": ["SE442005922401", "SE442005920801"] }

200
{ "list": ["SE442005920801"] }
```

Notes [docs]:

- Kivra strongly recommends matching before sending, except for retained content. Sending to a non-eligible recipient is denied unless the recipient is in grace period (and dormant recipients are delivered even though they do not match).
- `v1` usermatch was removed on 2025-04-30. Use the v2 endpoints above.
- The declared scope for usermatch is `get:kivra.v2.tenant.{tenantKey}.usermatch.ssn` even though the method is POST (spec quirk).

Sources: https://developer.kivra.com/starlight/docs/tenant-api/getting-started/recipient-matching/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/match-users-ssn-v2/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/match-companies-vatnr-v2/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/match-companies-with-papi-vatnr/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/list-companies-v2/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/list-companies-diff/

### 5.4 Sending content

```
POST /v2/tenant/{tenantKey}/content
Authorization: Bearer <token>
Content-Type: application/json
```

Minimum: exactly one recipient identifier (`ssn`, `email` or `vat_number`), `subject`, `type`. Missing recipient gives `40024`. [docs]

Common fields [docs]:

| Field | Type | Notes |
|---|---|---|
| `ssn` / `email` / `vat_number` | string | Person by SSN `YYYYMMDDnnnn` or verified email; company by VAT `SE##########01` |
| `subject` | string | Inbox title; keep to about 30 to 35 characters; no personal or sensitive data (GDPR art. 9) |
| `type` | string | Selects UX, notifications and validation (tables below) |
| `parts` | array | Files, base64 (see below) |
| `generated_at` | ISO 8601 date | Optional; controls inbox sort order; excluded from duplicate detection |
| `payment_multiple_options` | object | Required for invoice types |
| `invoice` | object | Structured invoice; required for `accounting.*` types (company recipients) |
| `retain`, `retention_time` | boolean, `"30"` \| `"390"` | Retained delivery, only for some types |
| `campaign` | `{ "tag": "..." }` | Optional campaign banner |

`parts[]` item (schema `Parts_Responsive`) [docs]:

```json
{
  "name": "faktura-1042.pdf",
  "content_type": "application/pdf",
  "data": "<base64 PDF>",
  "responsive_part": {
    "name": "faktura-1042.html",
    "content_type": "text/html",
    "data": "<base64 HTML>"
  }
}
```

`responsive_part` is optional HTML for mobile: no JavaScript, all CSS and images inline, no per-recipient tracking. Including it raises the content size limit from 1 MB to 2 MB. Content in Kivra always contains a PDF. [docs]

Content types relevant to us [docs]:

| `type` | Recipient | Purpose | Retain |
|---|---|---|---|
| `letter` | person, company | Non-payable letter (default for non-payable) | no |
| `letter.creditnotice` | person, company | Credit notice | yes |
| `invoice` | person, company | Invoice with payment data (default for payable) | no |
| `invoice.reminder` | person | Reminder of unpaid invoice | no |
| `invoice.debtcollection`, `invoice.debtcampaign`, `invoice.renewal`, `invoice.donation`, `invoice.paymentnotice` | person | Special invoice flows | no |
| `accounting.invoice` | company | Structured invoice for the receiver's accounting system; needs `invoice` object | n/a |
| `accounting.invoicereminder` | company | Structured reminder; needs `invoice` | n/a |
| `accounting.invoicecreditnote` | company | Structured credit invoice; needs `invoice` | n/a |
| `salaryslip` | person | Structured payslip (`salaryslip` object, JSON schema `https://se.kivra.com/schemas/json/salaryslip/v1.0`) | yes |
| `letter.salary` | person, company | Legacy payslip, **deprecated from 2026-10-01** | yes, until removal |

For company recipients the allowed `type` values are: `accounting.invoice`, `accounting.invoicereminder`, `accounting.invoicecreditnote`, `letter`, `invoice`, `letter.salary`, `letter.creditnotice`, `invite.research`, `invite.kyc`. [docs]

#### Example: PDF letter to a person

```json
{
  "ssn": "YYYYMMDDNNNN",
  "subject": "Information from Example AB",
  "type": "letter",
  "generated_at": "2026-10-19",
  "parts": [
    { "name": "brev.pdf", "content_type": "application/pdf", "data": "<base64 PDF>" }
  ]
}
```

For a company recipient replace `ssn` with `"vat_number": "SE442005920801"`.

#### Example: invoice to a person with OCR and bankgiro

```json
{
  "ssn": "YYYYMMDDNNNN",
  "subject": "Faktura 1042",
  "type": "invoice",
  "generated_at": "2026-10-19",
  "parts": [
    { "name": "faktura-1042.pdf", "content_type": "application/pdf", "data": "<base64 PDF>" }
  ],
  "payment_multiple_options": {
    "payable": true,
    "method": "1",
    "account": "1234-5678",
    "currency": "SEK",
    "options": [
      {
        "due_date": "2026-11-18",
        "amount": "1250.00",
        "type": "SE_OCR",
        "reference": "426523791"
      }
    ]
  }
}
```

#### Example: invoice to a company (plain, PDF plus payment data)

Same as above with `"vat_number": "SE442005920801"` instead of `ssn`. Kivra's own "invoice to company" example uses `"payable": false`, while the schema text says type `invoice` requires `payable: true`; confirm with Kivra which applies to company recipients (see section 6). [docs, contradictory]

#### Example: structured invoice to a company (`accounting.invoice`)

```json
{
  "vat_number": "SE442005920801",
  "subject": "Faktura 1042",
  "type": "accounting.invoice",
  "generated_at": "2026-10-19",
  "parts": [
    { "name": "faktura-1042.pdf", "content_type": "application/pdf", "data": "<base64 PDF>" }
  ],
  "invoice": {
    "invoice_number": "1042",
    "invoice_date": "2026-10-19",
    "due_date": "2026-11-18",
    "currency": "SEK",
    "total_amount_tax_exclusive": "1000.00",
    "total_vat_amount": "250.00",
    "total_amount_tax_inclusive": "1250.00",
    "rounding_amount": "0.00",
    "total_amount_due": "1250.00",
    "bankgiro": "123-4567",
    "payment_reference": { "value": "426523791", "reference_type": "ocr" },
    "buyer_reference": "REF-12345",
    "order_number": "ORD-789",
    "supplier_name": "Supplier AB",
    "supplier_organisation_number": "442005-9216",
    "supplier_vat_number": "SE442005921601",
    "supplier_address_street": "Stora gatan 123",
    "supplier_address_postal_code": "11122",
    "supplier_address_city": "Stockholm"
  }
}
```

`invoice` object rules [docs]: always required `total_amount_due` and `currency` (ISO 4217, not limited to SEK here). For `accounting.invoice` and `accounting.invoicereminder` also `due_date` plus at least one of `bankgiro` or `plusgiro`. `accounting.invoicecreditnote` needs only the two base fields and typically `original_invoice_number`. Other optional fields: `original_invoice_number`, `iban`, `bic`, the supplier address fields, `buyer_reference`, `order_number`. `payment_reference.reference_type` is `ocr` or `unstructured`. Amounts are decimal strings. The Content_company `invoice` description still says "BETA", but the changelog removed BETA from accounting invoices on 2026-06-04.

#### `payment_multiple_options` reference [docs]

| Field | Required | Notes |
|---|---|---|
| `payable` | yes | `true` makes it payable through Kivra's payment platform |
| `method` | yes | `"1"` = Bankgiro, `"2"` = Plusgiro (string) |
| `account` | yes | Destination BG/PG number, for example `"1234-5678"` |
| `currency` | yes | Only `"SEK"` |
| `options` | yes | Array; each option must differ in `amount` or `reference`. The **first** option drives notifications and is the only one shown in old clients. |
| `options[].due_date` | yes | `YYYY-MM-DD` |
| `options[].amount` | yes | Decimal string in SEK, `>= 1`, for example `"1250.00"` |
| `options[].type` | yes | `SE_OCR` (must pass OCR validation, else `40044 Invalid OCR`) or `TENANT_REF` (free reference) |
| `options[].reference` | yes | Max 25 characters |
| `options[].title`, `options[].description`, `options[].icon` | no | Title/description are overridden by `subject` when there is only one option; icon follows the tenant icon rules |
| `flexible_option` | no | Recipient picks the amount; needs at least one fixed option too; fields `due_date`, `type`, `reference`, `min_limit` (default 1.00), `max_limit`, `min_suggested`, `max_suggested` |
| `swish_alias` | no | Must be a Swish alias registered for the sender, or `"disable"`; never empty |
| `autogiro_destination` | no | Only value `"disable"` (turn off Kivra Autopay for this invoice) |
| `status` | read only | `paid` \| `unpaid` |

Notification cadence for `invoice` [docs]: alert immediately (push and email), push reminder 2 bank days + 2 days before due date, email reminder 1 bank day + 2 days before due date. Notifications can differ for company recipients.

Sources: https://developer.kivra.com/starlight/docs/tenant-api/send-content/content/ , https://developer.kivra.com/starlight/docs/tenant-api/send-content/invoices/ , https://developer.kivra.com/starlight/docs/tenant-api/send-content/letters/ , https://developer.kivra.com/starlight/docs/tenant-api/send-content/payment-functions/ , https://developer.kivra.com/starlight/docs/tenant-api/send-content/salary-slips/ , https://developer.kivra.com/starlight/docs/tenant-api/send-content/responsive-content/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/sendcontent/ , https://kivra.se/en/business/for-developers/payment-flows/invoices , https://kivra.se/en/business/partnersite/current

### 5.5 Send response

`201 Created` [docs]:

```json
{ "subject": "Faktura 1042", "generated_at": "2026-10-19", "type": "invoice" }
```

Headers:

- `kivra-objkey`: the content key. Store it; payment webhooks reference it as `content_key`.
- `location`: URL of the created object (there is no documented GET for it).
- `kivra-retained: true`: only present when the content was retained instead of delivered.

### 5.6 Delivery status and receipts

- The Tenant API documents **no endpoint to read delivery, opened or read status** of sent content, and no delivery webhook. A `201` means Kivra accepted the content; it does not prove the recipient experience is right. [docs]
- The only post-send signals are **payment webhooks** (5.7) and, for `invoice.renewal`/`invoice.donation` only, `invoice_declined`. Regular invoices cannot be declined. [docs]
- Therefore "sent via Kivra" in our UI should mean "accepted by Kivra (201, content key stored)". [inferred]

### 5.7 Payment webhooks (Tenant API)

Self-service definitions [docs]:

| Method | Path | Purpose |
|---|---|---|
| GET | `/v2/webhooks/payments` | List our definitions |
| POST | `/v2/webhooks/payments` | Create (`201`, returns the definition including a one-time `secret`) |
| PATCH | `/v2/webhooks/payments/{id}` | Modify (`200`; a new secret is issued and old and new both sign for 72 hours) |
| DELETE | `/v2/webhooks/payments/{id}` | Remove (`204`) |
| POST | `/v2/webhooks/payments/{id}/test` | Schedule a test delivery with static data (`204`) |

```json
POST /v2/webhooks/payments
{
  "url": "https://<our-host>/api/webhooks/kivra/payments",
  "cid_filter": "<our client key>",
  "tkey_filter": "*",
  "types": ["bank", "autogiro", "instant"],
  "events": ["scheduled", "settled", "failed"]
}
```

- `cid_filter`: the client that sent the invoice; must be a specific client key (ours). A wildcard needs an arrangement with Kivra.
- `tkey_filter`: a tenant key or `*` for all tenants we send for. Both filters cannot be `*`.
- `types`: `instant` (Swish), `bank`, `autogiro`. `events`: `scheduled`, `settled`, `failed`, `declined`. Valid combinations: instant: settled, failed; bank and autogiro: scheduled, settled, failed; declined: invoice level.
- Duplicate definitions mean duplicate deliveries.
- URL must be HTTPS, resolve to at least one IPv4 address, and not be in a reserved domain or IP range.
- Our endpoint must answer 2xx **within one second** of connection.

Signing follows **Standard Webhooks** (https://www.standardwebhooks.com): headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (space separated list like `v1,<base64> v1a,<base64>`). Signed content is `webhook-id + "." + webhook-timestamp + "." + rawBody`, HMAC-SHA256 with the definition's secret. Use the official Standard Webhooks library and verify the raw body. [docs]

Payload [docs]:

```json
{
  "id": "3f62fc97-907a-4212-af02-8c30f1ea1927",
  "timestamp": "2025-04-24T13:45:10Z",
  "type": "payment_callback",
  "data": {
    "content_key": "1691677075a9813e08f783496382b0bff743ec34ae",
    "payment_type": "bank",
    "payment_event": "settled",
    "event_time": "2025-04-24T13:44:58Z",
    "amount": "123.50",
    "currency": "SEK",
    "due_date": "2025-05-01",
    "pay_date": "2025-04-24",
    "destination_account_type": "bankgiro",
    "destination_account": "12345-6789",
    "remittance_type": "SE_OCR",
    "remittance_string": "426523791",
    "option_title": "Full payment",
    "option_id": "option_1"
  }
}
```

- `type`: `payment_callback`, `invoice_declined`, or deprecated `payment_callback_retry`.
- Swish payments add `swish_alias` and `swish_payment_reference`.
- `invoice_declined` data: `content_key`, `due_date`, `remittance_type`, `remittance_string`, `event_time`, `content_type` (`invoice.renewal` | `invoice.donation`).
- Retries on any non-200: immediately, then after 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h (10 attempts, about 75.5 hours), then dropped. Deduplicate on `webhook-id`.
- A Kivra "settled" event is a hint, not bookkeeping evidence: the bank statement remains the source for booking the payment. [inferred]

Sources: https://developer.kivra.com/starlight/docs/tenant-api/other-use-cases/webhooks/ , https://developer.kivra.com/starlight/docs/api/tenant/webhooks/webhook-payment/ , https://developer.kivra.com/starlight/docs/api/tenant/operations/create-payment-webhook/

### 5.8 Retained content

Content for a recipient not yet in Kivra (or who paused the sender) can be held and delivered when they register. Set `retain: true`; optional `retention_time` `"30"` (default) or `"390"` days. Only `letter.creditnotice`, `letter.salary`, `salaryslip`, `letter.signed` and `invite.sign` allow it; other types return `422` (`42221`). **Invoices cannot be retained.** Matching is not needed for retained flows. [docs]

Source: https://developer.kivra.com/starlight/docs/tenant-api/send-content/retained-content/

### 5.9 Duplicate control and idempotency

- In **production only**, Kivra delivers only the first of identical payloads; `generated_at` is ignored in the comparison. Later identical requests get an OK response but no new delivery. Sandbox has no duplicate control. [docs]
- Any byte difference (including a regenerated PDF) counts as a new delivery. To retry safely after a timeout, resend the exact stored payload. [docs]
- The legacy intro mentions idempotency keys but documents no header name; rely on payload-based duplicate control. [docs; header unknown]
- What the "OK" for a duplicate looks like (status code, whether `kivra-objkey` is the original key) is not documented. [open]

Recommended pattern [inferred]: render and store the PDF once, persist the exact JSON body (or its inputs plus PDF hash) per send attempt, and retry with identical bytes.

Source: https://developer.kivra.com/starlight/docs/tenant-api/send-content/duplicate-control/

### 5.10 Limits

[docs]

- One content (the whole JSON for one recipient, base64 files included) must be **under 1 MB**, or under 2 MB when a `responsive_part` is included. Base64 adds about 33 percent, so the raw PDF should stay below roughly 700 KB. [limit docs; arithmetic inferred]
- Max **50 contents per recipient per minute**; overall throughput across recipients is higher. Parallel requests are encouraged.
- Default max request payload **10 MB**; above gives `413` (`41300`).
- `429` (`42900`) when rate limited.

Source: https://developer.kivra.com/starlight/docs/tenant-api/other-use-cases/request-limits/

### 5.11 Errors

Format [docs]:

```json
{ "code": 40400, "short_message": "Not found", "long_message": "The resource was not found at the given URI at this time" }
```

- 5 digit code; first 3 digits are the HTTP status. Also returned in response header `x-error-code`. The OpenAPI schema types `code` as integer; Kivra's error repo shows it as a string. Parse both.
- `short_message` is stable per code; `long_message` may be overridden with specifics (for example a schema validation path). Do not branch on `long_message`.
- `5xx` is safe to retry (with the exact same payload, see 5.9).
- Kivra's sandbox guide warns that content rejected with an error is lost: we must surface failures, never swallow them.

Codes most relevant to us [docs]:

| Code | Meaning |
|---|---|
| 40000 / 40001 / 40059 | Validation failed / invalid request / schema violation |
| 40003 | Invalid or insufficient scope |
| 40008 / 40026 | Malformed JSON / payload not a JSON object |
| 40009 | SSN format |
| 40012 | `type` failed validation |
| 40015 | Invalid access token |
| 40018 | Company ID format |
| 40019 / 40028 | Invalid files / unsupported file type |
| 40021 | Invalid bank account |
| 40024 | No recipient (`ssn` or `vat_number`) given |
| 40030 / 40031 | Icon size / PNG without alpha |
| 40032 | No user exists with the SSN |
| 40042 | Amount out of range |
| 40044 | Invalid OCR |
| 40100 to 40104 | Auth failures (unauthorized, access denied, unauthorized client, invalid grant, invalid client) |
| 40300 | Forbidden |
| 40400 | Not found (also used when we may not know whether it exists) |
| 40915 | Org number already belongs to another tenant (create tenant conflict) |
| 41300 | Payload too large |
| 42221 | Retain requested for a type that does not support it |
| 42900 | Too many requests |

The authoritative list (190 codes) is https://github.com/kivra/kivra-api-errors/blob/main/api-errors.json (MIT; a Python module is included). The legacy table in swagger.bundle.yml uses slightly different wording.

Sources: swagger.bundle.yml "Errors", https://github.com/kivra/kivra-api-errors

### 5.12 Retention

- Kivra Business Plus marketing says stored content is kept at least seven years; a company that closes its Business account loses everything after 45 days. Neither is an archive guarantee for us. [docs]
- For (B), we already keep the invoice PDF and data as the seller's räkenskapsinformation; Kivra is only a delivery channel. For (A), the imported file in our own storage is the retained copy. [inferred]

---

## 6. Gotchas and open questions

Things to verify with Kivra before or during build:

1. **Partner-adapted onboarding link**: the flow is not documented publicly, and Kivra hands each partner its link. Ask: supported query parameters (state, return URL, prefilled org number), what happens for companies that already have Kivra Business, and whether `integration.created` is guaranteed to fire for the auto-activation path.
2. **Enskild firma**: Kivra Business does not support sole traders, so (A) cannot cover our enskild firma customers at all. For (B), sole trader recipients can only be reached as private persons by SSN. A sole trader's org number is their personnummer without century, so the SSN is derivable, but that needs a century decision and is personal data handling; decide deliberately. Also unknown: whether Kivra accepts an enskild firma as a **sender tenant** (`orgnr` VAT format is the same shape).
3. **No pagination on `GET /v3/partner/company/{companyKey}/content`**: ask about max result size and whether trashed or very old content is included.
4. **Backfill on activation**: does `content.created` fire for content received before activation? Assume not and list on `integration.created`.
5. **Receive-side enums**: `payment_options[].type` and `reference_type` are documented only by example (`bankgiro`, `OCR`). Ask for the full sets (plusgiro, IBAN, unstructured references).
6. **Money units differ**: PAPI `payment_options.amount` / `vat_amount` are integer **öre**; PAPI `accounting.*` amounts and all Tenant API amounts are decimal **strings in SEK**. Accounted rule: never use `toFixed()`. Build the outgoing string from integer öre (for example `Math.trunc(ore / 100)` and a zero-padded two digit remainder) and parse incoming strings into öre explicitly.
7. **Company invoice `payable`**: schema says type `invoice` requires `payable: true`; Kivra's own "invoice to company" example has `payable: false`. Ask whether companies can pay through Kivra at all, and what to send for B2B.
8. **Structured `accounting.invoice` is new** (announced 2026-10-14, Fortnox the only receiving system so far). Ask whether `payment_multiple_options` may be combined with `invoice`, whether it is billed differently, and how `accounting.invoicereminder` relates to `invoice.reminder` for companies (company `type` list does not include `invoice.reminder`).
9. **Content_company `parts` schema** in the OpenAPI points to the read-side `Parts` shape (`key`, `checksum`, `body`), but all examples use `name`/`data`/`content_type`. Send the example shape.
10. **No delivery or read receipts** in the Tenant API. Only payment webhooks exist. If product wants "opened" status, it is not available.
11. **Matching versus delivery**: dormant and grace-period recipients do not match but still receive content. Decide whether to send only to matched recipients (Kivra's recommendation) or allow sends to non-matched ones; the error code for "not eligible" on send is not documented (candidates: `40032`, `40105`, `40300`).
12. **OCR validation**: `SE_OCR` must "fulfill the requirements for OCR". Which Bankgirot check level (Luhn only, length digit) is applied is not stated. Use `TENANT_REF` when the customer's bankgiro is not set up for OCR.
13. **Duplicate control** is production only and payload based; behaviour of the duplicate response (status, `kivra-objkey`) is undocumented.
14. **Tenant creation is gated**: needs an agreement with Kivra for delegated sending, and probably the Legal API (Salesforce based, spec only on request) so each customer accepts Kivra's terms and DPA. Ask how per-sender pricing and invoicing works (Kivra bills per sender per item; billed to us or to each customer?). Pricing is not in the technical docs.
15. **Tenant conflicts (`409`)**: a customer already sending through Kivra via another platform owns its tenant. Our flow must handle `request_access`, which is asynchronous and may be rejected.
16. **Token scope refresh**: after creating a tenant or an accepted access request, cached tokens lack the new tenant. Invalidate the token cache on those events.
17. **Partner API rate limits**: none documented. Ask before running polling backfills across many companies.
18. **PAPI webhook registration and secret rotation** are manual via Kivra. Store the secret per environment; support multiple active secrets (Kivra sends one `X-KIVRA-SIGNATURE` per secret during rotation).
19. **Payment webhook endpoint must answer within 1 second**: persist and return immediately; process asynchronously. Our hosted routes must not do heavy work inline.
20. **`letter.salary` is deprecated from 2026-10-01**: use `salaryslip` (structured, needs the full `salaryslip` object) for payslips.
21. **Size limit**: 1 MB per content including base64 (2 MB with HTML). Large multi-page invoice PDFs with images may exceed it; compress or fail loudly.
22. **Sandbox fidelity**: no duplicate control, lower capacity, possibly newer builds. Do not load test there.
23. **Different webhook signing schemes**: PAPI uses `X-KIVRA-*` with `t:body` hex HMAC; payment webhooks use Standard Webhooks with base64 signatures. Two separate verifiers are needed.

---

## 7. Sources

Kivra developer docs (new "Starlight" site):

- https://developer.kivra.com/starlight/docs/partner-api/getting-started/overview/
- https://developer.kivra.com/starlight/docs/partner-api/getting-started/authentication/
- https://developer.kivra.com/starlight/docs/partner-api/getting-started/environments/
- https://developer.kivra.com/starlight/docs/partner-api/integration-guide/
- https://developer.kivra.com/starlight/docs/partner-api/webhooks/
- https://developer.kivra.com/starlight/docs/api/partner/ (operation and webhook reference pages)
- https://developer.kivra.com/starlight/docs/api-reference/partner-schemas/
- https://developer.kivra.com/starlight/docs/tenant-api/getting-started/overview/ (and authentication, environments, sandbox-credentials, tenants, recipient-matching, first-content, review-in-sandbox)
- https://developer.kivra.com/starlight/docs/tenant-api/send-content/content/ (and invoices, letters, payment-functions, salary-slips, retained-content, duplicate-control, responsive-content)
- https://developer.kivra.com/starlight/docs/tenant-api/other-use-cases/request-limits/
- https://developer.kivra.com/starlight/docs/tenant-api/other-use-cases/webhooks/
- https://developer.kivra.com/starlight/docs/api/tenant/ (operation and webhook reference pages)
- https://developer.kivra.com/starlight/docs/api-reference/tenant-schemas/

Specs:

- https://developer.kivra.com/starlight/openapi/partner-api.yaml
- https://developer.kivra.com/starlight/openapi/tenant-api.yaml
- https://developer.kivra.com/swagger.bundle.yml
- https://github.com/kivra/kivra-api-errors

Kivra product and partner pages:

- https://kivra.se/en/business/for-developers (and introduction, sandbox, production, tenant-onboarding, legal-onboarding, payment-flows/invoices)
- https://kivra.se/en/business/partnersite/current
- https://kivra.se/en/business/partnersite/getstarted
- https://kivra.se/sv/foretag/partnersida
- https://kivra.se/en/business/kivra-business , https://kivra.se/en/business/kivra-business/get-started , https://kivra.se/en/business/kivra-business/kivra-business-plus
- https://kivra.se/en/business/kivra-foretag/merging-service and the per-system pages (fortnox, spiris, briox, bflow, reda, accountec)

Third party (context only):

- https://support.fortnox.se/produkthjalp/foretagsbrevlada/foretagsbrevlada-kom-igang
- https://api.inexchange.com/docs/Send%20Invoice/DeliveryMethods/B2C/Kivra
- https://github.com/Sundsvallskommun/api-service-digital-mail-sender (MIT; real-world Tenant API client: usermatch then content)
