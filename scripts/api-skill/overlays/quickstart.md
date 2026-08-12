## Auth and base URL

Every request sends a bearer key:

```bash
curl https://app.gnubok.se/api/v1/companies \
  -H "Authorization: Bearer gnubok_sk_live_..."
```

- Base URL: `https://app.gnubok.se/api/v1` (legacy machine host, permanent).
  `https://app.accounted.se/api/v1` serves the identical API.
- Keys are created in the Accounted dashboard under **Settings -> API**
  (`/settings/api`). Two prefixes:
  - `gnubok_sk_live_*` commits real writes.
  - `gnubok_sk_test_*` reads real company data but forces every write into
    dry-run (responses carry `X-Gnubok-Mode: test`). Develop and run evals
    with a test key; switch to live last.
- Each key carries **scopes** (`invoices:read`, `invoices:write`,
  `payroll:write`, `webhooks:manage`, ...). Every endpoint in the index below
  is annotated with its required scope; a missing scope returns `403`.
- Rate limit: 100 requests/minute per key. On `429`, honor `Retry-After`.
- URLs carry the company id explicitly
  (`/api/v1/companies/{companyId}/invoices`). A key can act on any company its
  user is a member of; start every session with `GET /api/v1/companies` to
  discover ids. There is no implicit "current company".

First calls, in order: `GET /api/v1/health` (no auth, connectivity), then
`GET /api/v1/companies` (auth works, discover `companyId`).
