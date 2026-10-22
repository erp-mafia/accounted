# Billo integration reference

Reference for integrating Accounted with Billo (billo.life), a Swedish digital mailbox. It covers the four public Billo APIs and how they map onto the two things we want to build:

- **(A) RECEIVE**: create Billo mailboxes for our customers and pull the documents that arrive there into our document inbox.
- **(B) SEND**: send payslips (first), invoices and letters from our customers to their recipients.

Extracted from the Redoc pages on 2026-10-19. Everything below is written in our own words; endpoint paths, field names, enum values, status codes and error codes are copied exactly from the embedded OpenAPI documents.

**Legend used throughout**

- **[spec]**: stated in Billo's OpenAPI document or its intro text.
- **[discovery]**: read from Billo's public OpenID Connect discovery document (`/.well-known/openid-configuration`), not from the API docs.
- **[inferred]**: our reading or assumption; verify in sandbox before relying on it.

| API | Doc page | OpenAPI | Title / version in spec | Status |
|---|---|---|---|---|
| Partner API | https://developer.billo.life/partner/ | 3.1.0 | Billo Partner API 1.0.0 | **Draft** (spec says every URL and shape is provisional) |
| Mailbox API | https://developer.billo.life/mailbox/ | 3.1.0 | Billo Mailbox API 1.0.0 | **Draft** |
| SendEasy API | https://developer.billo.life/sendeasy/ | 3.0.4 | SendEasy API v1 | not marked draft |
| Sender API | https://developer.billo.life/sender/ | 3.0.1 | Billo Life api 1.0 | not marked draft |

`https://developer.billo.life/` is only a redirect to `/sender/`. There is no changelog, guide or sitemap page (all 404). The SendEasy page is a superset of the Sender page: it contains the SendEasy endpoint plus the exact same Tenant API operations and schemas as the Sender page (diffed: identical apart from tag names).

---


> **Corrections from Billo (Yaojia Wang, 2026-10-22), verified in the sandbox the same day.**
> - Accounted is **one partner customer** at Billo and our partner API key is bound to it (JWT claim `partner_customer_id`). Each Accounted company is an **end customer enrolled under it**; the key cannot create clients, so section 5.2 does not apply to us.
> - The webhook is registered on that partner customer (`POST /v1/clients/{partnerCustomerId}/webhook`): the partner-wide endpoints answer `403` to a customer-bound key.
> - SendEasy is `POST https://sandbox-api.billo.life/sendeasy/v1/Send`, not the spec's host. In the sandbox it still answers `400` errorCode `10020` "Sender not found" for a tenant created on the Sender API; how a sender is registered for SendEasy is an open question to Billo.
> - A document's sender name is the detail's `sender` field; `invoiceData.billerName` exists only on invoices.
## 1. Overview: which API does what

| API | Who authenticates | What it does | Our use case |
|---|---|---|---|
| **Partner API** | Accounted as *partner* (API key -> JWT) | Register our customers ("partner customers") as private persons or businesses; look them up; issue per-customer API keys; request Peppol receive registration for an enrolment | A (setup) |
| **Mailbox API** | Same JWT as Partner API (key must carry a `mailbox` service) | Enrol an *end customer* (the person or company whose mail is read) under a partner customer; mandate signing (BankID / physical / not required); list, read, download and mark documents; FAR (physical post forwarding); webhooks | A (core) |
| **SendEasy** | OAuth2 client credentials (see section 3.2; spec is thin here) | One call: PDF + recipient details. Billo classifies the document and extracts metadata. Billo users get it in the app; non-users get a secure preview link by email or SMS, opened with BankID or Freja eID | B (payslips, letters, invoices without full metadata) |
| **Sender API** ("Send with metadata" + Tenant API) | OAuth2 client credentials | Tenant (sender identity) management; recipient matching by `ssn`, `vat`, `upi`, `passport`; send content with full metadata (types `letter`, `letter.salary`, `invoice`, `invoice.reminder`, `invoice.debtcollection`, ...) | B (invoices with OCR/bankgiro; payslips to existing Billo users) |

Billo's own guidance on choosing a send endpoint [spec, sendeasy intro]: use **SendEasy** (`POST /api/v1/Send`) when you do not want to supply metadata (payslips, letters, invoices you lack data for); use **Send with metadata** (`POST /v1/tenant/{tenantKey}/content`) when you have all metadata (typically invoices). SendEasy reaches non-Billo users via preview links; Send with metadata reaches matched Billo users only, or *retains* content for non-users if that is contractually allowed.

### 1.1 Mapping onto Accounted

| Accounted concept | Billo concept |
|---|---|
| Accounted (the platform) | **partner** (Partner/Mailbox APIs); **client/integrator** (Sender/SendEasy) |
| An Accounted company (AB) | a **business end customer** enrolled under Accounted's own partner customer via `POST /v1/clients/{partnerCustomerId}/enrollments/business`. Billo 2026-10-22: our API key is bound to Accounted as one partner customer (the token's `partner_customer_id` claim) and cannot register customers of its own (`POST /v1/clients/business` answers `403`, errorCode 8) |
| An Accounted company (enskild firma) | a **private partner customer** (`POST /v1/clients`, by personnummer) and a **private end customer** enrolled via `POST /v1/clients/{partnerCustomerId}/enrollments` [inferred: an EF's organisationsnummer is the owner's personnummer, whose third digit is a month digit 0 or 1, so it fails the business route's "third digit >= 2" check] |
| Our `company_id` | `externalCustomerId` (partner-side id, opaque, max 255 chars, case-sensitive) |
| An Accounted company as a sender | a **tenant** (Sender API), identified by `tenantKey` |

Sources: https://developer.billo.life/partner/#section/Vocabulary, https://developer.billo.life/mailbox/#section/Vocabulary, https://developer.billo.life/sendeasy/#section/Choosing-a-send-endpoint

---

## 2. Environments and base URLs

| API | Sandbox | Production | Notes |
|---|---|---|---|
| Partner | `https://sandbox-api.billo.life/partner` | `https://api.billo.life/partner` | [spec] servers list. Example: prod token endpoint is `https://api.billo.life/partner/v1/auth/token` |
| Mailbox | `https://sandbox-api.billo.life/partner/mailbox` | `https://api.billo.life/partner/mailbox` | [spec] servers list. Paths are appended, e.g. `.../partner/mailbox/v1/webhook` |
| SendEasy | `https://sandbox-api.billo.life/sendeasy` | `https://api.billo.life/sendeasy` [inferred from the sandbox] | Billo 2026-10-22: the spec's `servers` entry (`sandbox-sender-api`, `/api/v1/Send`) is wrong; the endpoint is `POST https://sandbox-api.billo.life/sendeasy/v1/Send`. It takes the sender OAuth token |
| Sender | `https://sandbox-sender-api.billo.life` | `https://sender-api.billo.life` | Same as SendEasy. Pattern `https://[TYPE-]sender-api.billo.life/v1/tenant/...`, `TYPE` = `sandbox` or empty |
| Identity (OAuth2 for Sender/SendEasy) | `https://sandbox-identity.billo.life/connect/token` | `https://identity.billo.life/connect/token` | Sandbox URL is in the docs [spec]; production URL confirmed only via the OIDC discovery document [discovery] |

A gateway rewrites paths; if you see an extra `/api` segment in stack traces for Partner/Mailbox, that is internal and not part of the URL you call [spec].

Sandbox access for sending is requested by email to support@billo.life with company contact details [spec, sender intro]. Billo states sandbox availability and data are not guaranteed, and production must not be used for testing [spec].

---

## 3. Authentication

### 3.1 Partner API and Mailbox API: API key exchanged for a JWT

[spec] https://developer.billo.life/partner/#section/Authentication

1. `POST {partnerBase}/v1/auth/token` with header `x-api-key: <partner API key>`. No body needed (any body is ignored; empty JSON or none both accepted).
2. Response `200` (`AuthorizePartnerResponse`):

   ```json
   {
     "accessToken": "<JWT>",
     "expiresIn": 3600,
     "refreshToken": "<opaque, or null for a customer-bound key>",
     "scope": "partner.all mailbox.all"
   }
   ```

   `accessToken`, `expiresIn`, `scope` are required. `expiresIn` is seconds from response generation; the actual lifetime value is not documented (the `3600` above is a placeholder) [spec].
3. Every other call: `Authorization: Bearer <accessToken>`. The API key itself is **not** a valid bearer token.
4. Before expiry: `POST {partnerBase}/v1/auth/token/refresh` with body `{"refreshToken": "<latest>"}`. The refresh token may rotate; always store the one from the latest response. Expired or revoked refresh token answers **`403`** (not 401); missing/empty answers `400`. Then exchange the API key again.

The Mailbox API uses the **same token**, issued by the Partner API, provided the key was provisioned with a `mailbox` service. A key holding only `partner.all` reaches none of the Mailbox API [spec].

**Scopes** [spec]: keys are provisioned by Billo with "allowed services". Today Billo provisions `partner.all` and `mailbox.all`. Endpoints require the narrow scopes (`partner.read`, `partner.write`, `mailbox.read`, `mailbox.write`); `*.all` satisfies all of them. Matching is case-insensitive and hierarchical (`partner.all` or bare `partner` allows `partner.<anything>`; `partner.read` and `partner.write` match exactly and are independent: write does not imply read). Missing scope -> `403` with **no body**; missing/invalid token -> `401`.

Quirks of the `scope` field [spec]: the token response lists the key's allowed services joined by spaces; the JWT `scope` claim additionally contains `offline_access` for partner-wide keys, and the refresh endpoint returns the claim form (e.g. `mailbox.all offline_access partner.all`). A key provisioned with **no** allowed services reports an **empty** `scope` string but its token carries every service the partner holds.

**Caller types** [spec]: a *partner-wide* key reaches all our customers. A *customer-bound* key (issued via `POST /v1/clients/{partnerCustomerId}/api-keys`) reaches only that customer; other customers answer `404`; the four partner-level endpoints (`POST /v1/clients`, `POST /v1/clients/business`, `GET /v1/clients`, `GET /v1/clients/by-external-id/{externalCustomerId}`) and the partner-wide webhook endpoints answer `403`. Customer-bound tokens get `refreshToken: null` (present, not omitted) and are not refreshable.

**Credential format**: partner API keys look like `billo_sandbox-<hex>` / `billo_production-<hex>` [inferred for production; the spec only shows a sandbox-prefixed example]. A key's non-secret leading part is exposed as `keyPrefix` and is safe to log; the full key is not.

**401 bodies are not ProblemDetails** on token-protected endpoints [spec]: the auth layer writes `application/json` with PascalCase keys:

```json
{"Success": false, "Token": null, "Message": "Auth Failed", "MaskedPhoneNumber": null, "MFAEnabled": false}
```

A `401` from `POST /v1/auth/token` itself is a proper ProblemDetails with `errorCode: 3`. A missing `x-api-key` header is `401`, not `400`. Key off the HTTP status, never the body. `503` from the token endpoints means Billo could not reach its identity provider; retry with backoff.

### 3.2 Sender API and SendEasy: OAuth2 client credentials

[spec] https://developer.billo.life/sender/#section/API-Authentication (same text on the SendEasy page)

```
POST https://sandbox-identity.billo.life/connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<client_id>&client_secret=<client_secret>
```

Documented response shape:

```json
{
  "state": "",
  "access_token": "<token>",
  "expires_in": 28800,
  "scope": "billo.v1.tenant.{tenant-key}.*",
  "token_type": "bearer"
}
```

- Access tokens are valid **8 hours** (`expires_in: 28800`) [spec]. No refresh token; just request a new one at any time.
- Use as `Authorization: Bearer <access_token>`. Invalid token -> `401`.
- The prose says client id and secret "need to be base64 encoded", while the curl example sends them as form fields. The discovery document lists `token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"]` [discovery], so both HTTP Basic (the "base64" variant) and form fields should work [inferred].
- The token scope is per tenant (`billo.v1.tenant.{tenant-key}.*`). After creating a tenant, the client must **re-authenticate** to get the new tenant into its scope [spec].
- Discovery lists scopes including `sender`, `b2b.all`, `partner.all`, `partner.read`, `partner.write`, `mailbox.all`, `mailbox.read`, `mailbox.write`, `offline_access` and grant types including `client_credentials` and `trusted_api_key_exchange` [discovery]. Which scope SendEasy requires is **not documented**; `b2b.all` is a plausible candidate because SendEasy schemas live in the `Billo.Platform.Sender.B2B` namespace [inferred].
- **The SendEasy endpoint has no `securitySchemes` in its spec at all.** Its response field `partnerId` is "derived from the caller's authentication context", which hints that SendEasy may (also) accept a partner-style identity [inferred]. Confirm with Billo which credential and scope `POST /api/v1/Send` expects.

### 3.3 Credentials we hold

We have (values never go in the repo, logs, or this document):

- a **partner API key** for the Partner/Mailbox APIs (`billo_sandbox-...` style), sent only as `x-api-key` to `/v1/auth/token`;
- a separate **client id / client secret pair** for SendEasy (and presumably the Sender API), used only against the identity server token endpoint.

Store both as server-side env vars (Vercel encrypted). Cache access tokens in memory per environment; never persist them to the database. Webhook signing secrets (section 6.7) are a third secret we generate ourselves.

---

## 4. Domain model: partner, customer, end customer, enrolment, mandate

[spec] https://developer.billo.life/partner/#section/How-the-pieces-relate, https://developer.billo.life/mailbox/#section/Enrolling-an-end-customer:-a-person-or-a-company

```text
partner (Accounted)
  +- partner customer      created on the Partner API, id = partnerCustomerId
       +- enrolment        created on the Mailbox API, id = enrollmentId
            +- end customer   the person or company whose mail is read
            +- mandate        "forordnande", id = agreementId; the legal basis for access
```

- Registering a partner customer creates **only a record**: no mail, no documents, no Peppol. Mail flows only after an **enrolment**.
- Documents, webhooks and Peppol are all addressed by `enrollmentId`; keep it.
- One partner customer may enrol many end customers; **each end customer can be enrolled by one partner at a time across the whole Billo platform**. A second attempt gets `409` (`errorCode = 13`) and you cannot tell whether we or another partner hold it. Disconnecting releases the end customer.
- A private partner customer often enrols themselves (same person is customer and end customer) but the two ids stay distinct.
- The same identifier has several names: create responses call the customer id `id`, reads call it `partnerCustomerId`, webhooks call it `clientId`. The enrolment id appears as `enrollmentId`, as `customerId` (Peppol responses, document detail) and as `endCustomerId` (webhooks, FAR responses).

**Signing method matrix** (`forordnande.signingMethod`) [spec]:

| `signingMethod` | Private end customer | Business end customer | Also requires |
|---|---|---|---|
| `BankId` (default when `forordnande` is present without a method) | Yes | **No** (`400`) | the **partner customer** must be **private** (they are the second signing party and need a personnummer). A business partner customer gets `400` even for a private end customer |
| `Physical` | Yes | Yes | signed mandate PDF in `forordnande.fileName` + `forordnande.base64File`; active immediately |
| `NotRequired` | Yes | Yes | no file allowed (sending one is `400`); active immediately "on your word"; records that the mandate lives outside Billo |

Omitting `forordnande` entirely keeps legacy behaviour: the uploaded `agreement` file is treated as a physically signed mandate (so the file becomes required) and the enrolment is active at once.

**Consequence for us** [inferred from the matrix]: for an **AB**, BankID signing is impossible on both axes; we must use `Physical` (upload a signed PDF mandate) or `NotRequired`. For an **enskild firma**, the BankID flow works (private partner customer enrolling the same private person).

---

## 5. Partner API

Base: `https://api.billo.life/partner` (sandbox `https://sandbox-api.billo.life/partner`). All endpoints except the two token endpoints require `Authorization: Bearer`. Source for every row: https://developer.billo.life/partner/

| Method | Path | operationId | Scope | Success | Notable errors |
|---|---|---|---|---|---|
| POST | `/v1/auth/token` | issueAccessToken | none (`x-api-key` header) | `200` AuthorizePartnerResponse | `401` (errorCode 3), `429`, `500`, `503` |
| POST | `/v1/auth/token/refresh` | refreshAccessToken | none | `200` AuthorizePartnerResponse | `400`, `403` expired/revoked, `429`, `503` |
| POST | `/v1/clients` | onboardClient | `partner.write` | `200` OnboardPartnerCustomerResponse | `400`, `401`, `403`, `409`, `429` |
| GET | `/v1/clients` | listClients | `partner.read` | `200` PagedResult of Client | `400`, `401`, `403`, `429` |
| POST | `/v1/clients/business` | onboardBusinessClient | `partner.write` | `200` OnboardPartnerCustomerResponse | `400`, `401`, `403`, `409`, `429` |
| GET | `/v1/clients/{partnerCustomerId}` | getClientById | `partner.read` | `200` Client | `401`, `403`, `404`, `429` |
| GET | `/v1/clients/by-external-id/{externalCustomerId}` | getClientByExternalId | `partner.read` | `200` Client | `401`, `403`, `404`, `429` |
| POST | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/peppol` | requestPeppolRegistration | `partner.write` | `200` RequestPeppolRegistrationResponse | `400` (transient), `401`, `403`, `404`, `429` |
| GET | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/peppol` | getPeppolRegistrationStatus | `partner.read` | `200` PartnerCustomerPeppolStatusResponse | `401`, `403`, `404`, `429` |
| POST | `/v1/clients/{partnerCustomerId}/api-keys` | registerClientApiKey | `partner.write` | `201` RegisterClientApiKeyResponse | `400` (errorCode 5 or 0), `401`, `403`, `404`, `429` |
| GET | `/v1/clients/{partnerCustomerId}/api-keys` | listClientApiKeys | `partner.read` | `200` PagedResult of ClientApiKey | `400`, `401`, `403`, `404`, `429` |
| POST | `/v1/clients/{partnerCustomerId}/api-keys/{apiKeyId}/revoke` | revokeClientApiKey | `partner.write` | `204` | `400`, `401`, `403`, `404`, `429` |
| POST | `/v1/clients/{partnerCustomerId}/api-keys/{apiKeyId}/disable` | disableClientApiKey | `partner.write` | `204` | `400` if revoked, ... |
| POST | `/v1/clients/{partnerCustomerId}/api-keys/{apiKeyId}/enable` | enableClientApiKey | `partner.write` | `204` | `400` if revoked, ... |

`partnerCustomerId`, `enrollmentId` and `apiKeyId` are UUIDs. There is **no** endpoint to update, deactivate or delete a partner customer.

### 5.1 Register a private customer: `POST /v1/clients`

Required: `name` (max 255), `ssn` (max 100), `externalCustomerId` (max 255). Optional: `email` (format email, max 255), `phoneNumber` (pattern `^\+[1-9]\d{7,14}$`, E.164).

```json
{
  "name": "<full legal name>",
  "ssn": "<YYYYMMDDNNNN>",
  "externalCustomerId": "<our company uuid>",
  "email": "<optional>",
  "phoneNumber": "+46XXXXXXXXX"
}
```

- `ssn` accepts `YYYYMMDDXXXX`, `YYYYMMDD-XXXX`, `YYMMDD-XXXX` and plain ten digits; date structure and Luhn are validated.
- **Replay is idempotent on `ssn`, but matched on the exact string as sent** (no normalisation): sending the same person as `8501011236` after `198501011236` creates a second customer, or `409` if `externalCustomerId` is reused. **Always send the 12-digit form.**
- Reusing an `externalCustomerId` for a different person -> `409` (ProblemDetails, `errorCode: 409`). Missing `externalCustomerId` -> `400` `"ExternalCustomerId is required."`
- Success is **`200`** (not 201), no `Location` header.

### 5.2 Register a business customer: `POST /v1/clients/business`

Required: `name` (max 255), `orgNumber` (max 100), `externalCustomerId` (max 255), `email` (format email, max 255), `phoneNumber` (pattern `^\+[1-9]\d{7,14}$`).

```json
{
  "name": "<registered company name>",
  "orgNumber": "<NNNNNN-NNNN>",
  "externalCustomerId": "<our company uuid>",
  "email": "<contact email>",
  "phoneNumber": "+46XXXXXXXXX"
}
```

- `orgNumber` accepted hyphenated (`NNNNNN-NNNN`), plain 10 digits or 12 digits with `16` prefix; stored and returned as plain 10 digits.
- Validation: Luhn check digit **and third digit >= 2** (the group digit separating legal entities from personal numbers). A Luhn-valid number with third digit 0 or 1 is refused.
- Replay on the same `orgNumber` returns the existing customer with `alreadyRegistered: true` (normalised, so form does not matter). Reusing `externalCustomerId` for another company -> `409`.
- Does **not** start mail, scanning or Peppol.

### 5.3 Create response: `OnboardPartnerCustomerResponse` (both routes)

Required: `id`, `partnerId`, `name`, `status`, `createdAt`, `alreadyRegistered`.

```json
{
  "id": "<uuid = partnerCustomerId>",
  "partnerId": "<uuid, our own partner id>",
  "name": "string",
  "externalCustomerId": "string or null",
  "ssn": "string or null (private only)",
  "orgNumber": "string or null (business only, 10 digits)",
  "email": "string or null",
  "phoneNumber": "string or null",
  "status": "Active",
  "createdAt": "date-time",
  "updatedAt": "date-time or null",
  "alreadyRegistered": false
}
```

`status` is `Active` or `Inactive`; new customers start `Active`.

### 5.4 Read shape: `Client`

Used by `GET /v1/clients` (items), `GET /v1/clients/{partnerCustomerId}` and `GET /v1/clients/by-external-id/{externalCustomerId}`. Required: `partnerCustomerId`, `name`. Other fields: `externalCustomerId`, `email`, `ssn` (returned **unmasked**), `orgNumber`, `phoneNumber`. No `status`, no timestamps.

`GET /v1/clients` query: `page` (1-based, default 1), `pageSize` (default 20, max 500; above 500 is `400`, not clamped), `status` (`Active` | `Inactive`). Sorted by creation time descending. A page past `totalPages` returns `200` with empty `items`.

`by-external-id`: case-sensitive match, scoped to us; URL-encode reserved characters.

`PagedResult` envelope (all list endpoints on Partner and Mailbox): `items`, `totalCount`, `page`, `pageSize`, `totalPages`, `hasPreviousPage`, `hasNextPage` (all required). No pagination headers; the only custom response header is `X-Correlation-Id`.

### 5.5 Peppol receive registration (per enrolment)

`POST /v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/peppol` (no body) asks Billo to give the enrolment a Peppol address. Asynchronous (against Maventa): `200` means *accepted*, not *registered*. Asking twice does not start a second registration. Only companies registered as **AB** can get a Peppol address; other forms surface as `Failed` or `Conflicted` status, not as an error here. `404` when no such enrolment under that customer. `400` when the customer could not be read (transient; retry).

Response `RequestPeppolRegistrationResponse` (required `partnerCustomerId`, `customerId`, `requested`):

```json
{"partnerCustomerId": "<uuid>", "customerId": "<uuid = enrollmentId>", "requested": true, "reason": null}
```

`GET` same path -> `PartnerCustomerPeppolStatusResponse` (required `partnerCustomerId`, `customerId`, `status`, `statusUnavailable`):

```json
{
  "partnerCustomerId": "<uuid>",
  "customerId": "<uuid = enrollmentId>",
  "peppolId": "string or null (set when Active)",
  "status": "Pending",
  "failureReason": "string or null",
  "statusUnavailable": false
}
```

`status` enum: `Pending`, `Active`, `Cancelled`, `Failed`, `Conflicted`, `Inactive`, `Unknown`. `Inactive` = never requested; `Conflicted` usually = org number already registered elsewhere on the Peppol network; `Unknown` always comes with `statusUnavailable: true` (Billo could not reach the Peppol service; poll again, not a failure).

### 5.6 Per-customer API keys (optional for us)

`POST /v1/clients/{partnerCustomerId}/api-keys` body (required `name` max 100, `allowedServices` non-empty array; optional `expiresAt` in the future):

```json
{"name": "<label>", "allowedServices": ["mailbox.all"], "expiresAt": "2027-01-01T00:00:00Z"}
```

`201` `RegisterClientApiKeyResponse` (required `id`, `partnerId`, `partnerCustomerId`, `name`, `apiKey`, `keyPrefix`, `allowedServices`, `status`, `createdAt`; plus `updatedAt`, `expiresAt`, `lastUsedAt`, `revokedAt`). **`apiKey` is returned exactly once** (only a salted hash is stored). `status` enum: `Active`, `Disabled`, `Revoked`. An empty `allowedServices` is refused (it would mean "everything"). Customer must be `Active`. You cannot grant services our organisation does not hold. Billo sends nothing to the customer; delivering the key is our job.

List: `GET .../api-keys?page&pageSize&statuses=Active&statuses=Disabled&serviceCodes=...` (repeatable arrays), newest first, never includes key material (`ClientApiKey` has `keyPrefix` instead). `revoke` is terminal and stops token exchange immediately (existing access tokens live until expiry); `disable` / `enable` are reversible; both answer `400` on a revoked key.

We probably do not need customer-bound keys: we act as the partner for all customers. They could be used later to narrow blast radius per customer [inferred].

### 5.7 Errors (Partner)

RFC 7807 `application/problem+json` with extension fields `correlationId` (also in `X-Correlation-Id` header) and `errorCode` [spec]. `errorCode` values: `0` invalid request, `1` not found, `3` bad API key at `/v1/auth/token`, `5` validation failed, `8` forbidden (customer-bound token on a partner-level endpoint). Failures from a DB constraint or domain rule carry the **HTTP status** as `errorCode` (duplicate `externalCustomerId` -> `errorCode: 409`; disable/enable on a revoked key -> `errorCode: 400`). Match on the pair (status, errorCode). Validation messages are joined with `; ` in `detail`; a field-keyed `errors` object appears only for model-binding failures.

---

## 6. Mailbox API

Base: `https://api.billo.life/partner/mailbox` (sandbox `https://sandbox-api.billo.life/partner/mailbox`). Same bearer token as the Partner API. Source: https://developer.billo.life/mailbox/

| Method | Path | operationId | Scope | Success |
|---|---|---|---|---|
| POST | `/v1/clients/{partnerCustomerId}/enrollments` | createEnrollment | `mailbox.write` | `200` OnboardCustomerForPartnerResponse |
| GET | `/v1/clients/{partnerCustomerId}/enrollments` | listEnrollments | `mailbox.read` | `200` PagedResult of EnrollmentSummaryResponse |
| POST | `/v1/clients/{partnerCustomerId}/enrollments/business` | createBusinessEnrollment | `mailbox.write` | `200` OnboardCustomerForPartnerResponse |
| DELETE | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}` | disconnectEnrollment | `mailbox.write` | `204` |
| GET | `/v1/clients/{partnerCustomerId}/signatures` | listEnrollmentSignatures | `mailbox.read` | `200` PagedResult of EnrollmentSignatureResponse |
| GET | `/v1/clients/{partnerCustomerId}/signatures/{agreementId}` | getEnrollmentSignature | `mailbox.read` | `200` EnrollmentSignatureResponse |
| DELETE | `/v1/clients/{partnerCustomerId}/signatures/{agreementId}` | cancelEnrollmentSignature | `mailbox.write` | `200` EnrollmentSignatureResponse |
| GET | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/documents` | listEnrollmentDocuments | `mailbox.read` | `200` PagedResult of DocumentSummary |
| GET | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/documents/{documentId}` | getDocument | `mailbox.read` | `200` DocumentDetailResponse |
| PATCH | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/documents/{documentId}` | updateDocumentStatus | `mailbox.write` | `204` |
| GET | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/documents/{documentId}/download` | getDocumentDownloadUrl | `mailbox.read` | `200` DocumentDownloadResponse |
| POST | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/far/register/init` | initFarRegistration | `mailbox.write` | `200` InitFarResponse |
| POST | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/far/register` | completeFarRegistration | `mailbox.write` | `200` FarStatusResponse |
| POST | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/far/unregister/init` | initFarUnregistration | `mailbox.write` | `200` InitFarResponse |
| POST | `/v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}/far/unregister` | completeFarUnregistration | `mailbox.write` | `200` FarStatusResponse |
| POST | `/v1/webhook` | upsertWebhook | `mailbox.write` | `200` UpsertWebhookResponse |
| DELETE | `/v1/webhook/{id}` | removeWebhook | `mailbox.write` | `204` |
| POST | `/v1/clients/{partnerCustomerId}/webhook` | upsertClientWebhook | `mailbox.write` | `200` UpsertWebhookResponse |
| DELETE | `/v1/clients/{partnerCustomerId}/webhook` | removeClientWebhook | `mailbox.write` | `204` |

### 6.1 Enrol a private end customer: `POST /v1/clients/{partnerCustomerId}/enrollments`

Body `OnboardCustomerForPartnerRequest` (required: `customer`):

```json
{
  "customer": {
    "ssn": "<YYYYMMDDNNNN, exactly 12 chars>",
    "name": "<optional, max 255>",
    "email": "<optional>",
    "phone": "+46XXXXXXXXX",
    "alternativeAddress": {
      "careOf": null,
      "line1": "<street>",
      "line2": null,
      "postalCode": "<postal code>",
      "city": "<city>",
      "country": "SE"
    }
  },
  "agreement": {
    "agreementType": "<free-form, max 100; confirm values with Billo>",
    "fileName": "<optional, .pdf>",
    "base64File": "<optional, base64 PDF, no data: prefix>"
  },
  "forordnande": {
    "signingMethod": "BankId",
    "redirectUrl": "https://<host allow-listed by Billo>/billo/signed"
  }
}
```

`CustomerInfo` (end customer): required `ssn` (12 chars, `YYYYMMDDXXXX`, checksum + date validated). Note the field is **`phone`** here, not `phoneNumber` (pattern `^\+[1-9]\d{7,14}$`). If the person is new to Billo this call registers them; if already known, the existing record is reused as is (including any `alternativeAddress` they already have; ours is then silently not stored).

`AlternativeAddressInput`: required `line1` (1 to 255), `postalCode` (1 to 20), `city` (1 to 100); optional `careOf`, `line2` (max 255), `country` (pattern `^[A-Z]{2}$`, default `SE`). An object with every field empty counts as not sent; a partially filled one missing `line1`/`postalCode`/`city` is `400`. It is **not** the scanning address (that is `billoAddress` in the response).

`AgreementInfo`: required `agreementType` (free-form string, max 100, no enum validation yet). `fileName` (max 255, should end `.pdf`, not enforced) and `base64File` (format byte) must be sent together or not at all. This is our own contract with the customer; it is stored but **grants nothing** (unless `forordnande` is omitted, see section 4).

`ForordnandeInfo`: `signingMethod` (`BankId` | `Physical` | `NotRequired`, default `BankId`), `redirectUrl` (BankId only, absolute `https://`, max 2048, **host must be on a per-partner allow-list held by Billo**; no endpoint to register or read it; otherwise `400`; falls back to a Billo-hosted page when omitted), `fileName` / `base64File` (required for `Physical`, rejected for `BankId` and `NotRequired`).

Files travel inline as base64 in the JSON body. Billo sets no limit; the gateway in front returns a `413` that is not ProblemDetails. Keep uploads to a few MB. Base64 must be valid (`errorCode = 12`, `InvalidBase64File`) and the decoded bytes must start with `%PDF` (`errorCode = 7`, `InvalidPdfFile`).

### 6.2 Enrol a company end customer: `POST /v1/clients/{partnerCustomerId}/enrollments/business`

Body `OnboardBusinessCustomerForPartnerRequest` (required: `customer`; `agreement` and `forordnande` as on the private route). `BankId` is always refused on this route (`400`).

```json
{
  "customer": {
    "orgNumber": "<NNNNNN-NNNN>",
    "companyName": "<company name>",
    "addressLine1": "<street>",
    "postalCode": "<postal code>",
    "city": "<city>",
    "representativeName": "<name>",
    "representativeSsn": "<YYYYMMDDNNNN>",
    "representativeEmail": "<email>",
    "representativePhone": "+46XXXXXXXXX",
    "ownerName": null,
    "ownerEmail": null,
    "ownerSsn": null
  },
  "agreement": {
    "agreementType": "<confirm with Billo>",
    "fileName": "<optional>.pdf",
    "base64File": "<optional base64>"
  },
  "forordnande": {
    "signingMethod": "Physical",
    "fileName": "<signed mandate>.pdf",
    "base64File": "<base64 PDF of the signed mandate>"
  }
}
```

`BusinessCustomerInfo`: required `orgNumber` (max 100; same Luhn + third-digit >= 2 rule as the Partner API), `companyName` (max 255), `representativeName` (max 255), `representativeSsn` (exactly 12 digits, personnummer, never echoed back), `representativeEmail` (email, max 255), `representativePhone` (E.164 pattern). Address is required in **exactly one** form: either `addressLine1` (max 255) + `postalCode` (max 20) + `city` (max 100), or `alternativeAddress` (then `careOf` and `line2` are refused; `country` defaults to `SE`). Both forms at once is `400`.

Optional owner: `ownerName` (max 255), `ownerEmail` (email), `ownerSsn` (12 digits). Send `ownerSsn` + `ownerEmail` together or none; Billo then has the representative invite the owner into the company in the Billo app and emails them, naming our partner customer. Owner invite and representative access only happen for a company Billo did not already know (`companyAlreadyRegistered: false`).

For `NotRequired` replace `forordnande` with `{"signingMethod": "NotRequired"}` and send no file. The schema makes `agreement` optional [spec]; whether `{customer, forordnande: {"signingMethod": "NotRequired"}}` alone is accepted is [inferred], verify in sandbox.

Enrolling the same org number twice resolves to the same Billo customer and answers `409`.

### 6.3 Enrolment response: `OnboardCustomerForPartnerResponse` (both routes)

Required: `enrollmentId`, `agreementId`, `name`, `email`, `ssn`, `phone`, `status`, `signingMethod`, `createdAt`.

```json
{
  "enrollmentId": "<uuid>",
  "agreementId": "<uuid>",
  "name": "string (person or company name)",
  "email": "string",
  "ssn": "string (empty string for a company)",
  "orgNumber": "string or null",
  "phone": "string",
  "customerNumber": "string or null (Billo customer number)",
  "billoAddress": {
    "careOf": "string or null (usually carries the customer number)",
    "line1": "string or null",
    "line2": "string or null",
    "postalCode": "string or null",
    "city": "string or null",
    "state": "string or null",
    "country": "string or null"
  },
  "alternativeAddress": null,
  "companyAlreadyRegistered": null,
  "status": "PendingSignature",
  "signingMethod": "BankId",
  "signUrl": "https://... (only while PendingSignature)",
  "createdAt": "date-time"
}
```

- **A `200` is not proof of enrolment.** With BankID, `status` is `PendingSignature` and nothing is granted until the partner customer signs at `signUrl`. `Physical` and `NotRequired` return `Active`.
- `billoAddress`: Billo's scanning address for this end customer (built from `customerNumber`); give it to senders of paper post. Created once, then frozen. `null` if not created yet.
- `alternativeAddress` is always `null` while `PendingSignature`; read it later from `GET .../enrollments`.
- `companyAlreadyRegistered`: `true` if Billo already held the company (then the representative got no access and no owner was invited), `false` if this call registered it, `null` for a person.
- The response echoes submitted PII (`name`, `email`, `ssn`, `phone`). Do not log it.

`PartnerAgreementStatus` enum: `PendingSignature`, `Active`, `Rejected` (partner customer refused; terminal), `Failed` (signing case could not start; terminal, retry allowed), `Superseded` (signed, but another partner won the race; no access), `Revoked` (disconnected), `Cancelled` (we withdrew; end customer released), `Expired` (signing request timed out; released).

Errors: `400` (validation, signing method not applicable, inactive partner customer with `errorCode = 0`, base64 `12`, PDF `7`), `404` (unknown `partnerCustomerId` for us), `409` (`errorCode = 13`, `EndCustomerAlreadyOnboarded`; also when a mandate for the same end customer is already awaiting signature under this partner customer), `413` (gateway), `500` (`errorCode = 6` `FailedToUploadAgreementFile`; on the business route also `errorCode = 8` `FailedToOnboardEndCustomer`; or failure to start BankID).

### 6.4 Following a BankID signing

- `GET /v1/clients/{partnerCustomerId}/signatures/{agreementId}` -> `EnrollmentSignatureResponse` (required `agreementId`, `enrollmentId`, `status`, `signingMethod`, `createdAt`; plus `signUrl`, `signedAt`, `rejectedAt`). `signUrl` stays available while outstanding (resend a lost link), cleared when settled. **This is the only way to see a refusal**; there is no signing webhook.
- `GET /v1/clients/{partnerCustomerId}/signatures?page&pageSize` lists all attempts newest first; use it to recover an `agreementId` whose enrolment response was lost (a live attempt blocks a new enrolment with `409`).
- `DELETE /v1/clients/{partnerCustomerId}/signatures/{agreementId}` withdraws an outstanding signing (`200` with final state, typically `Cancelled`); `400` if already signed or never pending; `503` `errorCode = 27` `SigningProviderUnavailable` (nothing changed, retry).
- `GET /v1/clients/{partnerCustomerId}/enrollments` lists **only granted** enrolments (`EnrollmentSummaryResponse`: required `enrollmentId`; plus `customerNumber`, `billoAddress`, `alternativeAddress`), newest first. With a partner-wide token an unknown customer id gives an empty page, not `404`.

### 6.5 Disconnect: `DELETE /v1/clients/{partnerCustomerId}/enrollments/{enrollmentId}`

Revokes the agreement and removes document access; webhooks stop. `204` on success. **Not idempotent**: a second call answers `400` with `errorCode = 0`. `404` only when the `partnerCustomerId` does not exist at all (this route does not scope the lookup to us).

### 6.6 Documents

**Visibility window**: only documents delivered **after** access was granted are listed; older ones are not listed and fetching them by id gives `403` (`errorCode = 24`, `DocumentAccessDenied`). Disconnecting and re-enrolling starts a new window; earlier documents do not come back [spec].

**List**: `GET .../enrollments/{enrollmentId}/documents`

Query parameters (complete list): `page` (default 1), `pageSize` (default 20, max 500), `documentType` (`DocumentType` name case-insensitive, or its integer), `status` (`DocumentStatus` name case-insensitive, filtered by the document service). Sorted by **creation time descending**. There is **no** `since`, cursor, date range, or `updatedAfter` parameter.

`DocumentSummary` (required: `id`, `title`, `type`, `status`, `isRead`, `created`, `updated`):

```json
{
  "id": "<uuid = documentId>",
  "title": "string",
  "type": "INVOICE",
  "status": "Processed",
  "isRead": false,
  "created": "date-time",
  "updated": "date-time",
  "publishedAt": "date-time or null"
}
```

- `type` is `DocumentType`: `UNKNOWN` (0), `LETTER` (1), `INVOICE` (2), `OTHER` (3), `RECEIPT` (4), `TICKET` (5). Responses emit the name.
- `status` on the summary is a **free-form pipeline state** (e.g. `Processed`, `Pending`, `Failed`), not the `DocumentStatus` enum used by the filter and PATCH. Treat as opaque.
- `publishedAt` non-null is the canonical "is published" signal.

**Detail**: `GET .../documents/{documentId}` -> `DocumentDetailResponse` (required `id`, `created`, `customerId`, `type`, `status`). Supported fields only:

```json
{
  "id": "<uuid>",
  "created": "date-time",
  "updated": "date-time or null",
  "customerId": "<uuid = enrollmentId>",
  "customer": {"id": "<uuid>", "name": "string or null", "customerNumber": "string or null", "email": "string or null"},
  "type": "Invoice",
  "status": "string",
  "title": "string or null",
  "publishedAt": "date-time or null",
  "supplierId": "uuid or null (internal reference)",
  "invoiceData": {
    "billerName": "string or null",
    "number": "string or null (invoice number as printed)",
    "account": "string or null (PG/BG digits when applicable)",
    "accountType": "BG",
    "dueDate": "date-time or null",
    "invoiceDate": "date-time or null",
    "amount": 1234.5,
    "amountPaid": null,
    "minimumAmount": null,
    "status": "UNHANDLED",
    "remittanceInfoType": "OCR",
    "remittanceMessage": "string or null (OCR digits or free text)",
    "paymentProvider": "string or null (internal)",
    "invoiceReference": "string or null",
    "isReminder": null,
    "isPayable": null,
    "changed": null
  }
}
```

- Detail `type` is a plain string like `Letter` / `Invoice` (different casing from the list's `DocumentType` enum). Normalise case before comparing.
- `invoiceData` is set only for invoices and every field inside may be missing (extraction-based). Required inside: `status`, `remittanceInfoType`. `amount` is the total due in the invoice's currency; **no currency field is documented**.
- Enums: `InvoiceStatus` = `UNHANDLED`, `HANDLED`, `PAYMENT_SCHEDULED`, `PAYMENT_COMPLETE`, `PAYMENT_FAILED`, `REFUSED`. `AccountType` = `NOT_SET`, `PG` (Plusgiro), `BG` (Bankgiro), `OTHER`. `RemittanceInfoType` = `OCR`, `UNSTRUCTURED`.
- The body also carries undocumented fields (`subType`, `documentSource`, `sender`, `isPublished`, `trainingData`, `automaticallyPublished`, `isUserEdited`, `isUserPublished`, `diggBodyText`, `diggBodyContentType`, `properties`, `attachments`). Billo says explicitly **not** to read them; they may change without notice. So: there is **no supported sender field** (use `invoiceData.billerName` for invoices, `title` otherwise), **no supported attachments list**, and **no supported Peppol/source indicator**.
- `500` with `errorCode = 11` (`FailedToFetchDocuments`) on fetch failures.

**Download**: `GET .../documents/{documentId}/download` -> `DocumentDownloadResponse` (all required):

```json
{
  "documentId": "<uuid>",
  "fileName": "string",
  "contentType": "application/pdf",
  "downloadUrl": "https://<signed object storage URL>",
  "expiresAt": "date-time"
}
```

Short-lived signed URL to the original PDF; each call mints a new one; do not cache or share. Fetch it immediately with a plain GET [inferred: no bearer header needed for a signed storage URL]. Only the main PDF is downloadable; there is no endpoint for attachments.

**Status update**: `PATCH .../documents/{documentId}` body `UpdateDocumentRequest` (required `status`):

```json
{"status": "HANDLED"}
```

`DocumentStatus` enum: `READ`, `UNREAD`, `HANDLED`, `UNHANDLED`, `PAID`. `204` on success; `503` `errorCode = 26` (`DocumentServiceError`, nothing changed). Setting `READ` is expected to fire `InvoiceRead` / `ReceiptRead` / `LetterRead` back to us, but Billo marks that path **unconfirmed**. The status is shared with the Billo app, so marking `HANDLED` is visible to the end customer [spec: "so a partner's own UI and the Billo app stay in agreement"].

### 6.7 Polling strategy (no cursor exists)

[inferred] Recommended approach given the API surface:

1. Webhook first: on `PartnerDocumentReceived`, fetch detail + download for that `documentId` (route by `clientId` / `endCustomerId`, or resolve via our stored enrolments for the snake_case variant).
2. Reconciliation poll (cron) per active enrolment: `GET .../documents?page=1&pageSize=100`, walk pages (newest first) until a page contains only `id`s we already imported, or an item's `created` is older than our stored high-water mark minus a safety margin. Upsert by Billo `documentId` (unique constraint) so webhook and poll never double-import.
3. Do not use `status=UNHANDLED` + `PATCH HANDLED` as a work queue unless the customer agrees: it changes the state they see in the Billo app.

### 6.8 FAR (physical post forwarding)

FAR is the Swedish forwarding-address register; registering routes the end customer's physical post to Billo for scanning. It is keyed on personnummer, so the **end customer** signs, and an end customer without SSN on record gets `400` [spec]. In practice this applies to private end customers (EF owners) [inferred].

- `POST .../far/register/init` and `POST .../far/unregister/init` body `InitFarRequest` (both required):

  ```json
  {"signingProvider": "billobankid", "flow": "browser-desktop-qr"}
  ```

  `FarSigningProvider`: `billobankid` | `freja` (lower case; `criipto` and `nets` refused). `FarFlow`: `mobile`, `browser-mobile`, `browser-desktop-qr`, `browser-desktop-external-device`.
  Response `InitFarResponse`: `enrollmentId` (required) and exactly one of `signatureUrl` (redirect) or `signatureBody` (object of string fields to post to the provider).
- `POST .../far/register` and `POST .../far/unregister` body `FarSignatureRequest` (all required):

  ```json
  {"signingProvider": "billobankid", "flow": "browser-desktop-qr", "proxySignatureId": "<from provider>", "signature": "<signature material>"}
  ```

  Response `FarStatusResponse`: `{"endCustomerId": "<uuid>", "status": "Complete"}`. `FarAuthorizationStatus`: `Complete` (in effect), `Pending` (re-check later), `Error`, `Rejected` (FAR refused; comes back as `200`, not an error), `Incomplete` (collect a fresh signature and resubmit).
- Billo decides itself whether it is a new registration or a move from another mailbox operator.
- Errors: `409` `errorCode = 13` (already registered in FAR with Billo), `500` `18` `FailedToInitiateFar`, `19` `FailedToRegisterFar`, `20` `FailedToInitiateFarUnregistration`, `21` `FailedToUnregisterFar`, `503` `16` `FarServiceError`.

### 6.9 Webhooks

**Register** (partner-wide, one per partner): `POST /v1/webhook` body `UpsertWebhookRequest` (all required):

```json
{
  "callbackUrl": "https://<our host>/api/extensions/billo/webhook",
  "secret": "whsec_<base64 random bytes>",
  "eventTypes": ["PartnerDocumentReceived", "InvoicePaid", "InvoiceRead", "ReceiptRead", "LetterRead"]
}
```

- `callbackUrl`: absolute `https://`, max 2048; not resolved or called at registration (bad hosts only show up as failed deliveries).
- `secret`: required, non-empty; Billo signs with it. Billo recommends a base64 value, optionally `whsec_`-prefixed, for Standard Webhooks library interop.
- `eventTypes` (`WebhookEventType`): `InvoicePaid`, `InvoiceRead`, `ReceiptRead`, `LetterRead`, `PartnerDocumentReceived`; at least one; duplicates ignored.
- Upsert: replaces URL, secret and events in place; keeps `id` and `createdAt`. Response `UpsertWebhookResponse` (required `id`, `callbackUrl`, `eventTypes`, `status`, `createdAt`; plus `updatedAt`, `null` on create). `status` is currently always `Active`. `500` = `WebhookRegistrationFailed`. `400` also if the partner behind the token no longer exists.
- `DELETE /v1/webhook/{id}`: idempotent `204`.
- Per-customer webhook: `POST /v1/clients/{partnerCustomerId}/webhook` (same body/response) adds a second callback for that customer only; the partner-wide one **still fires too**, so events arrive twice. `DELETE /v1/clients/{partnerCustomerId}/webhook` is idempotent (`204`); `500` `errorCode = 10`. The two partner-wide endpoints answer `403` to customer-bound tokens.

**Delivery** [spec] https://developer.billo.life/mailbox/#section/Webhook-callbacks

- `POST` to `callbackUrl`, `Content-Type: application/json`, compact JSON body, UTC ISO-8601 timestamps.
- Header **`X-Billo-Event-Type`** carries the event name. Route on it; bodies do not name the event and several share one shape.
- Events fire only for partner customers we hold an enrolment for. `PartnerDocumentReceived` = new document published; `InvoiceRead` / `ReceiptRead` / `LetterRead` = end customer opened it (or we set its status); `InvoicePaid` = invoice settled.
- **No event for mandate signing or refusal**; poll the signature endpoint.

**Signature verification (Standard Webhooks)**:

| Header | Meaning |
|---|---|
| `webhook-id` | Unique message id; stable across retries; the idempotency key |
| `webhook-timestamp` | Unix epoch **seconds** |
| `webhook-signature` | Space-separated list of `v1,<base64>` entries |

Each signature is base64 of `HMAC-SHA256(key, "{webhook-id}.{webhook-timestamp}.{rawBody}")`. Verify against the **raw request bytes** (do not re-serialise). Reject if no entry matches or the timestamp is outside our tolerance (replay protection).

**Key derivation is ambiguous** [open question]: the spec says the HMAC key is "the secret you supplied", while also recommending a `whsec_`/base64 secret for Standard Webhooks library interop. Standard Webhooks libraries strip `whsec_` and base64-decode the remainder to get the key bytes. Until Billo confirms, generate `whsec_` + base64(32 random bytes) and verify in sandbox which interpretation matches. Sketch using only `node:crypto` (adding the `standardwebhooks` package would be a new dependency and needs approval):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verifyBilloSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const id = headers.get('webhook-id')
  const timestamp = headers.get('webhook-timestamp')
  const signatureHeader = headers.get('webhook-signature')
  if (!id || !timestamp || !signatureHeader) return false

  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(timestamp)) > toleranceSeconds) return false

  // ASSUMPTION (Standard Webhooks convention): key = base64-decoded secret without the whsec_ prefix.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest()

  return signatureHeader.split(' ').some((entry) => {
    const [version, value] = entry.split(',')
    if (version !== 'v1' || !value) return false
    const given = Buffer.from(value, 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
```

**Payloads**:

`MailboxEventPayload` (all five events when raised by the Mailbox service; camelCase; all four fields required):

```json
{
  "documentId": "<uuid>",
  "endCustomerId": "<uuid = enrollmentId>",
  "clientId": "<uuid = partnerCustomerId>",
  "occurredAt": "2026-06-03T09:15:18.1234567Z"
}
```

`PartnerDocumentReceivedWebhookPayload` (older second producer of `PartnerDocumentReceived` only; snake_case; nullable but populated in practice; does **not** identify enrolment or customer):

```json
{"document_id": "<uuid>", "event_time": "2026-06-03T09:15:18.123Z"}
```

Handle both shapes (key off whichever of `documentId` / `document_id` exists). The two producers send **different `webhook-id`s for the same document**, so dedupe on `webhook-id` **and** on document id. `InvoicePaid` carries no amount, date or reference; fetch the document.

**Responding and retries**: any `2xx` acknowledges. Anything else or a timeout is a failure; Billo retries **5 times** after the first attempt, at 30s, 10m, 1h, 3h and 6h, then drops the delivery. Delivery is at-least-once; handlers must be idempotent. Respond fast and do the fetch/download asynchronously [inferred].

### 6.10 Errors (Mailbox)

Same ProblemDetails envelope (`correlationId`, `errorCode` from `MailBoxFailureReasons`). Important difference: for refusals raised by the Mailbox service itself (signing-method refusals, `409`s, `404`s) the **specific sentence is in `title`** and `detail` holds a generic label (`"Invalid request"`, `"End customer is already onboarded"`); validation failures put specifics in `detail`. Log `title`.

Documented `errorCode` values: `0` InvalidRequest, `6` FailedToUploadAgreementFile, `7` InvalidPdfFile, `8` (two meanings: `403` customer-bound token on a partner endpoint; `500` FailedToOnboardEndCustomer on the business route), `10` FailedToDeleteWebhookConfig, `11` FailedToFetchDocuments, `12` InvalidBase64File, `13` EndCustomerAlreadyOnboarded (also "already registered in FAR"), `16` FarServiceError, `18` FailedToInitiateFar, `19` FailedToRegisterFar, `20` FailedToInitiateFarUnregistration, `21` FailedToUnregisterFar, `24` DocumentAccessDenied, `26` DocumentServiceError, `27` SigningProviderUnavailable. `WebhookRegistrationFailed` has no documented number. Always match on (HTTP status, errorCode).

`403` has three shapes: no body (scope missing), ProblemDetails `errorCode = 8` (customer-bound token on a partner endpoint), ProblemDetails `errorCode = 24` (document predates the access grant).

---

## 7. SendEasy

Source: https://developer.billo.life/sendeasy/#tag/Send

`POST {sendeasyBase}/v1/Send` (see the corrections above) with `Content-Type: application/json` (also accepts `text/json`, `application/*+json`). Billo classifies the document, extracts metadata, and delivers: Billo users in the app; non-users get a **secure preview link** by email and/or SMS, and must authenticate with **BankID or Freja eID** matching the provided SSN before viewing [spec, intro].

Request `SendB2BDocumentRequest` (no field is marked required in the schema; `additionalProperties: false`):

```json
{
  "documentType": "Payslip",
  "fileName": "payslip-2026-10.pdf",
  "fileContent": "<base64 PDF, max 10 MB after decoding>",
  "receiver": {
    "ssn": "<personnummer>",
    "firstName": "<first name>",
    "lastName": "<last name>",
    "email": "<email>",
    "phoneNumber": "+46XXXXXXXXX",
    "billoCustomerNumber": null
  },
  "tenantKey": "<tenant key, schema says uuid>"
}
```

- `documentType` (`B2BDocumentType`): `Letter`, `Receipt`, `Payslip`, `Invoice`. Optional: omitted means Billo's AI classifier decides; set it to lock the type. For payslips, always set `Payslip` [inferred].
- `fileName`: must be a `.pdf` (only PDF accepted). `fileContent`: base64 PDF.
- `receiver` (`B2BReceiver`, `additionalProperties: false`): `ssn` (used for BankID/Freja authentication; the example is hyphenated `YYYYMMDD-NNNN`), `firstName`, `lastName` (shown on the preview link and stored as metadata), `email` (preview link delivered here when present), `phoneNumber` (E.164; link delivered by SMS when present), `billoCustomerNumber` (optional; when omitted a customer record is **created or matched** by SSN/email/phone). **At least one of `email` or `phoneNumber` is required** for non-Billo recipients. `hasAnyIdentifier` is read-only; do not send it. `receiver` may be omitted "when the supplier handles delivery out of band".
- `tenantKey`: the tenant on whose behalf it is sent. The schema says `format: uuid`, while Sender API tenant keys look like long hex strings (see section 8). Confirm the format with Billo.

Response `200` `SendB2BDocumentResponse`:

```json
{
  "id": "<uuid, SendEasy document id>",
  "documentId": "<uuid or null; null if the pipeline did not reach publishing>",
  "partnerId": "<uuid or null; from the caller's auth context>",
  "status": "Published"
}
```

`B2BDocumentStatus` enum: `MetaDataAdded`, `MissingFile`, `Error`, `MissingDetails`, `ReadyToSend`, `Publishing`, `Published`. `Published` means the recipient can open it via the preview link. Errors: `400` with a `Microsoft.AspNetCore.Mvc.ProblemDetails` body (`type`, `title`, `status`, `detail`, `instance`, extension fields allowed), `500` without body.

Not documented for SendEasy: authentication scheme and scope (section 3.2), any GET/status endpoint for a sent document, webhooks or delivery/open receipts, channel preference when both email and phone are given, link expiry, cost/pricing per send, retries/idempotency, and the production URL (only inferable from the shared intro).

---

## 8. Sender API (Tenant API + Send with metadata)

Base: `https://sender-api.billo.life` (sandbox `https://sandbox-sender-api.billo.life`). Bearer token from the identity server (section 3.2). Source: https://developer.billo.life/sender/ (identical operations also on https://developer.billo.life/sendeasy/).

Recommended flow [spec]: get credentials -> create tenant -> use the tenant key -> match recipients -> send content.

### 8.1 Tenant management

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| POST | `/v1/tenant` | `Tenant` | `201` created; `200` already existed and was added to our client scope | `409` a tenant with that `orgnr` exists outside our scope (use `request_access`) |
| GET | `/v1/tenant?orgnr=<VAT>` | none | `200` array of `{"key": "<tenant key>"}` | |
| PUT | `/v1/tenant/{tenantKey}/name` | `{"name": "<display name>"}` | `200` empty | |
| POST | `/v1/tenant/{tenantKey}/company_id` | `{"company_id": {"name": "<legal name>", "orgnr": "SE<10 digits>01"}}` | `204` | `409` another tenant has that `orgnr` |
| DELETE | `/v1/tenant/{tenantKey}/company_id/{orgNr}` | none (`orgNr` is the VAT number, e.g. `SE<10 digits>01`) | `204` | |
| POST | `/v1/tenant/{tenantKey}/icon` | `{"file": {"name": "<name>", "data": "<base64 PNG>", "content_type": "image/png"}}` | `204` | |
| POST | `/v1/tenant/request_access` | `{"vat_number": "SE<10 digits>01"}` | `201` `RequestAccess`, `location` header | |
| GET | `/v1/tenant/request_access/{requestKey}` | none | `200` `RequestAccess` | |

Create tenant body (`Tenant`, required `name`, `company_id`):

```json
{
  "name": "<sender name shown in the recipient's inbox>",
  "company_id": [
    {"name": "<legal company name>", "orgnr": "SE<10 digits>01"}
  ]
}
```

- Despite the name, `orgnr` holds the **VAT number** (`SE` + 12 digits).
- **The tenant key is returned in the `billo-objkey` response header** (and the `location` header URL). The `Tenant` response schema has no key field (only read-only `created_at`, `created_by`, `status`, plus deprecated `edit_security_level`, `groups`, `visibility`, `class`). Capture the header.
- The new tenant is added to our client scope, but we must **request a new access token** before using it.
- Creating tenants via API is only allowed in specific cases regulated in our agreement with Billo [spec].
- Name changes show for recipients only after they receive new content.
- Icon: square PNG, 256x256 to 512x512 px, 32-bit with alpha channel, up to 1 MB.
- `RequestAccess` fields: `request_key`, `created_at`, `created_by`, `status` (`PENDING`, `PROCESSING`, `APPROVED`, `REJECTED`, `ONHOLD`; example shown in lower case), `client_id`, `client_name`, `tenant_name`, `tenant_key`. Poll until `APPROVED` or `REJECTED`. Re-posting the same request returns the same object with updated status. Use case: the customer's company already has a Billo tenant managed by another client (e.g. a previous invoicing provider).

### 8.2 Recipient lookup (matching)

Recipients are only reachable if they are active Billo users who have not opted out of this tenant (users must log in at least once every 12 months to count as active). Sending to an unavailable recipient is denied (typically error `40105`), except during a grace period [spec].

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/v1/tenant/{tenantKey}/usermatch` | `{"ssns": ["YYYYMMDDNNNN", "..."]}` | `200` `{"ssns": [<subset eligible>]}` (empty list if none) |
| POST | `/v1/tenant/{tenantKey}/usermatch/upi` | `{"upis": ["<Freja UPI>", "..."]}` | `200` `{"upis": [<subset>]}` |
| POST | `/v1/tenant/{tenantKey}/usermatch/passport` | `{"passports": ["<passport no>", "..."]}` | `200` `[{"passport": "...", "upi": "... or null"}]` |
| POST | `/v1/tenant/{tenantKey}/companymatch/vatnr` | `{"list": ["SE<10 digits>01", "..."]}` (required `list`) | `200` `{"list": [<subset>]}` |
| GET | `/v1/tenant/{tenantKey}/user?include=ssn&page=1&pageSize=1000` | none | `200` array of `{"ssn": "YYYYMMDDNNNN"}`; access may be disabled per agreement |
| GET | `/v1/tenant/{tenantKey}/company?page=1&pageSize=1000` | none | `200` array of `{"vatnr": "SE<10 digits>01"}` (pattern `^SE[0-9]{10}01$`); headers `X-Page-Count`, `X-Current-Page`, `X-Page-Size`, `X-Total`, `diffId` |

Match payloads are capped at 10 MB (about 500,000 identifiers), `413` above. A `diffId` header is described for incremental sync via `/v1/tenant/{tenantKey}/user/diff/{diffId}` and `/v1/tenant/{tenantKey}/company/diff/{diffId}`, but those diff endpoints are **not specified**.

### 8.3 Send content: `POST /v1/tenant/{tenantKey}/content`

Body `Content_user` (required `subject`, `files`; **exactly one** recipient identifier among `ssn` (`YYYYMMDDnnnn`), `vat` (`SE` + 12 digits), `upi`, `passport`):

| Field | Notes |
|---|---|
| `ssn` / `vat` / `upi` / `passport` | exactly one |
| `subject` | shown in the recipient's inbox. No personal data in metadata fields (GDPR Art. 9 note in the spec) |
| `generated_at` | ISO 8601, optional; used for sorting in the Billo app |
| `type` | `letter` (default for non-payable), `letter.salary`, `letter.creditnotice`, `invoice` (default for payable), `invoice.reminder`, `invoice.debtcampaign`, `invoice.renewal`, `invoice.debtcollection`, `booking`. All `invoice*` types require a valid `payment` object with `payable: true` |
| `retain` | default `false`; retain undeliverable content until the user registers. **Never `true` for payable content.** Allowed only where our agreement with Billo permits |
| `retention_days` | retention period when retaining (default 30 days; typically 390 for payslips) |
| `files` | array of `File`: required `name`, `data` (base64), `content_type`; optional `responsive_part` (`name`, `data`, `content_type`, typically `text/html`). `additionalProperties: false` |
| `context.invoice` | required `payment`; optional `invoice_reference` (our invoice number) |
| `context.booking` | array of `{title, description, location, info_url, start_time, end_time}` |

`Payment` (all required except `min_amount`; `additionalProperties: false`):

| Field | Type | Meaning |
|---|---|---|
| `payable` | boolean | payable via Billo apps; Billo uses this data to actually execute payments, so it must be correct |
| `currency` | string | ISO 4217; in Sweden only `SEK` |
| `due_date` | string | schema says `date-time`, every example uses `YYYY-MM-DD` |
| `total_owed` | string | decimal string, e.g. `"12500.00"` |
| `type` | string | `"SE_OCR"` or `"TENANT_REF"` (format of `reference`) |
| `method` | string | `"1"` = Bankgiro, `"2"` = Plusgiro |
| `account` | string | our customer's BG/PG number (format, with or without hyphen, not specified) |
| `reference` | string | OCR number (or tenant reference) |
| `min_amount` | string, nullable | minimum payable amount |

**Payslip to an existing Billo user**:

```json
{
  "ssn": "YYYYMMDDNNNN",
  "subject": "Lönespecifikation oktober 2026",
  "generated_at": "2026-10-25",
  "type": "letter.salary",
  "retain": false,
  "files": [
    {"name": "payslip-2026-10.pdf", "data": "<base64 PDF>", "content_type": "application/pdf"}
  ]
}
```

With a retention agreement, set `"retain": true, "retention_days": 390` to reach employees who are not Billo users yet (content is held and delivered if they register in time).

**Invoice with OCR and Bankgiro to a business** (for a private recipient replace `vat` with `ssn`):

```json
{
  "vat": "SE<10 digits>01",
  "subject": "Faktura 1042",
  "generated_at": "2026-10-19",
  "type": "invoice",
  "retain": false,
  "files": [
    {"name": "faktura-1042.pdf", "data": "<base64 PDF>", "content_type": "application/pdf"}
  ],
  "context": {
    "invoice": {
      "payment": {
        "payable": true,
        "currency": "SEK",
        "due_date": "2026-11-18",
        "total_owed": "12500.00",
        "type": "SE_OCR",
        "method": "1",
        "account": "<bankgiro number>",
        "reference": "<OCR number>"
      },
      "invoice_reference": "1042"
    }
  }
}
```

Format `total_owed` from integer öre (e.g. `"12500.00"`); never via `toFixed()` on a float (repo money rule) [inferred]. For reminders use `"type": "invoice.reminder"`, for collection claims (inkassokrav) `"invoice.debtcollection"`, same `payment` block.

**Response**: `201` "Content Created", body declared as `Content_user` (its identifier and file fields are write-only, so expect little back), headers **`billo-objkey`** (object key, hex) and **`location`** (URL of the created object). A `billo-retained: true` header signals the content was retained rather than delivered; the spec documents it on `POST /v1/tenant` (`200`), which looks misplaced [inferred: it belongs to the content response].

**Duplicate control** (production only, not sandbox): an identical payload (ignoring `generated_at`) is delivered only once; repeats answer OK without delivery. Any change, including a regenerated PDF, defeats it. To retry safely after a timeout, resend the exact same bytes.

**HTML responsive part**: no JavaScript; all assets inline; no per-user tracking links.

**Errors**: conventional HTTP codes; `5xx` is safe to retry. Body format:

```json
{"code": 404, "short_message": "Resource not found", "long_message": "There's no resource at the given URI."}
```

Error `40105` = recipient not available to this tenant (fall back to paper/email).

**Statuses and webhooks**: the Sender API documents **no** status endpoint for sent content and **no** webhooks. The Mailbox spec mentions that richer payment events are delivered to "sender and distributor webhooks", which are not documented publicly.

---

## 9. Rate and size limits

| Area | Limit | Source |
|---|---|---|
| Partner / Mailbox | No rate limiter of Billo's own; `429` may come from the gateway, honour `Retry-After` if present | [spec] `TooManyRequests` |
| Partner / Mailbox lists | `pageSize` max 500 (`400` above) | [spec] |
| Mailbox enrolment uploads | No Billo limit; gateway `413`; keep to a few MB | [spec] |
| Sender / SendEasy | **50 contents per minute to the same recipient** (unlimited across different recipients) | [spec] Limits |
| Sender content | 10 MB per content per recipient, measured on the whole JSON (base64 overhead included) | [spec] |
| Request payload (Sender/SendEasy) | 10 MB default; `413` above | [spec] |
| SendEasy file | 10 MB after decoding (but the 10 MB request cap applies to the base64 JSON, so the practical PDF cap is roughly 7.5 MB) | [spec] + [inferred] |
| Match endpoints | 10 MB (about 500,000 identifiers) | [spec] |
| Sender token | 8 hours | [spec] |

---

## 10. Data protection roles (brief)

From Billo's public terms (https://billo.life/terms and the linked PDFs; summarised, not copied):

- For the **company digital mailbox** ("Villkor för Billo ABs digitala brevlåda för företag och organisationer", and the "Personuppgiftsbiträdesavtal mellan Billo AB och Användare", v1.0 of 2024-12-17): the **user (the company)** is controller for processing in the mailbox and **Billo is processor**. Billo also processes some data for its own purposes as controller.
- Billo's privacy notice: while Billo conveys an e-document, the **sender** is controller and Billo processor for the sender; once the document is available in the mailbox, controllership passes to the **user**, with Billo as the user's processor.
- Not covered by the public terms: our role as partner reading a customer's mailbox. The mandate (`forordnande`) is the legal basis for our access. Our likely role is processor (or sub-processor) for the customer; this needs a decision and DPA update [open question].
- Sender API rule: tenants must keep personal data out of metadata fields [spec].

---

## 11. Gotchas and open questions

**Spec maturity**

1. Partner and Mailbox specs are marked **Draft**: URLs and shapes may change. Pin behaviour with sandbox contract tests.
2. The Partner spec still references stale paths (`POST /v1/mailbox/customers/{partnerCustomerId}/enrollments`, `POST /customers`, `POST /customers/business`). The real enrolment path is `{mailboxBase}/v1/clients/{partnerCustomerId}/enrollments`.
3. Sender/SendEasy spec defects: `servers` lists only sandbox; `UserMatchupi` is a broken `$ref` (schema is `UserMatchUPI`); `variable_amount` appears in an example but not in the `Payment` schema (which forbids extra properties); one `invoice.debtcampaign` example puts `invoice_reference` outside `invoice`; `billo-retained` documented on the tenant endpoint; diff endpoints referenced but not specified; grace period stated as 90 days (deactivation) and 45 days (opt-out); email convention says RFC 5322 on one page and E.123 on the other.

**Authentication**

4. SendEasy has **no documented auth scheme or scope**. We hold a client id/secret pair for it; confirm token endpoint, scope (`b2b.all`? `sender`?) and whether it is the same client as the Sender API.
5. Partner access token lifetime is not documented; read `expiresIn`. Refresh tokens rotate; expired refresh is `403`.
6. Partner `401` bodies are PascalCase non-ProblemDetails; `403` for missing scope has no body.
7. Narrow scopes (`partner.read`, `mailbox.read`, ...) exist but Billo provisions `*.all` today.

**Receiving (Partner + Mailbox)**

8. **No cursor or `since` on document listing**; newest-first paging plus id dedupe is the only option (section 6.7). Ask Billo for `createdAfter` or a cursor.
9. **Webhook HMAC key derivation** (raw secret string vs base64-decoded `whsec_` secret) is ambiguous. Test in sandbox.
10. Two `PartnerDocumentReceived` producers with different body shapes and different `webhook-id`s; dedupe on document id.
11. No webhook for mandate signing/refusal; poll `GET .../signatures/{agreementId}`.
12. **AB customers cannot use BankID** mandates (business partner customer and business end customer are both refused). Options are `Physical` (we collect a signed PDF mandate) or `NotRequired` (on our word). Which one we may legally and contractually use is a decision for us and Billo.
13. **Enskild firma**: cannot be registered on the business routes (third digit rule). It must be a private customer + private enrolment by personnummer, which means **reading the owner's entire private Billo mailbox**, not just business mail [inferred]. Ask Billo whether a business-only scope exists for EF; otherwise we need explicit consent and filtering.
14. One partner per end customer platform-wide: if the customer already connected Billo to another partner (accounting firm, other ERP), we get `409` `errorCode = 13` with no way to tell who holds it.
15. Only documents delivered after the grant are visible; no backfill. Re-enrolment resets the window.
16. Document detail has no supported sender, attachments, currency or source/Peppol field; only the main PDF is downloadable.
17. `DocumentType` casing differs between list (`INVOICE`) and detail (`Invoice`); summary `status` is free-form, unlike the `DocumentStatus` filter.
18. `PATCH` status is visible to the end customer in the Billo app and its webhook echo is unconfirmed.
19. `agreementType` is free-form; get the accepted values from Billo.
20. `redirectUrl` hosts need Billo allow-listing (no API); ask Billo to add our production and preview hosts.
21. SSN normalisation: Partner `POST /v1/clients` matches replays on the exact string; Mailbox requires exactly 12 digits; SendEasy example is hyphenated. Always send 12 digits without hyphen unless Billo says otherwise.
22. Disconnect is not idempotent (second call `400`, `errorCode = 0`).
23. No update or delete for partner customers; customer email/phone cannot be changed via API.
24. Peppol via Billo is AB-only (Maventa) and will be `Conflicted` if the org number is already on Peppol, for example through our existing Qvalia receive path. Decide which provider owns Peppol receive per customer before calling it.
25. `errorCode` reuse: `8` and `13` each have two meanings; Partner errors may carry the HTTP status as `errorCode`.

**Sending (SendEasy + Sender)**

26. SendEasy `tenantKey` is typed `uuid`, Sender tenant keys look like long hex strings. Which key SendEasy wants is unclear.
27. SendEasy has no status endpoint, no webhooks, no documented cost, no idempotency key; a retry may send twice [inferred]. It creates a Billo customer record for non-users.
28. Sender `POST /v1/tenant` returns the tenant key only in the `billo-objkey` header; re-authenticate before using it. Creating tenants via API needs a contractual go-ahead.
29. Sender duplicate control works only in production; regenerate nothing between retries.
30. `retain` must never be `true` for payable content, and retention in general needs an agreement.
31. Bankgiro/Plusgiro `account` format (digits only vs hyphenated) is not specified.
32. No webhooks for sent content (payment/opened) are publicly documented.

---

## 12. Re-extracting the specs

The OpenAPI documents are embedded in each Redoc page as `__redoc_state = {...}`; the spec is at `.spec.data`. To refresh (keep downloads and scripts in separate directories, run Python isolated):

```bash
mkdir -p "$OUT/raw" && for n in partner mailbox sendeasy sender; do
  curl -sL -o "$OUT/raw/$n.html" "https://developer.billo.life/$n/"
done
```

```python
# extract.py <page.html> <out.json>; run with: python3 -I extract.py ...
import json, sys
html = open(sys.argv[1], encoding="utf-8").read()
start = html.index("__redoc_state = ") + len("__redoc_state = ")
state, _ = json.JSONDecoder().raw_decode(html[start:])
json.dump(state["spec"]["data"], open(sys.argv[2], "w", encoding="utf-8"), indent=2, ensure_ascii=False)
```

Raw specs are reference material for engineers and are deliberately not committed.
