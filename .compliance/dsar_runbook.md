# Data Subject Rights Runbook

First decide whose data the request is about. Our role differs, and so does
who answers.

| The request is about | Our role | Who answers |
|---|---|---|
| A user's own account, login, support or analytics data | Controller (/privacy) | We do, within one month |
| Data in a company's bookkeeping (its customers, suppliers, employees) | Processor (/dpa) | The company. We forward the request to its owners without undue delay and do not answer it ourselves (/dpa point 8) |
| A customer ending its agreement and asking for deletion | Processor (/dpa point 13) | We do, within 30 days of the written request |

Always verify the requester first: reply only to the e-mail address on the
account, or ask for BankID identification in the app.

## A user's own data (we are controller)

- **Access and portability:** export the user's profile, company memberships,
  preferences, API key labels (never the keys) and support history. Bookkeeping
  belongs to the companies and is exported by them in the app (SIE4, full
  archive, CSV).
- **Erasure:** the user deletes the account in the app
  (`src/app/api/account/delete/route.ts`, `erase_user_personal_data`). That
  blocks while the user owns an active company. Then also delete the person in
  PostHog (project settings, persons, delete with events). The DB keeps a
  banned `auth.users` tombstone so bookkeeping keeps a stable actor id.
- **Objection** to product analytics: switch analytics off for the user and
  delete the person in PostHog.

## Customer identity data

For access, correction, restriction, portability, or erasure requests, first
verify the requester and the tenant relationship. Search the company-scoped
customer record and any retained accounting documents. Customer master data may
be corrected or erased when no legal retention duty applies. Accounting records
and issued invoice documents remain retained for the statutory period; document
the Article 17(3)(b) exception in the response.

Full personal numbers are never returned through the ordinary customer API.
Exports and support evidence must use the masked value unless a separately
approved identity-verification procedure requires otherwise.

## A customer's employees

Payroll data (salary, absence including sick leave, union fee deductions) is
the employer's. Forward requests to the company. The company can export an
employee's payslips and salary runs; posted salary runs are accounting records
and stay for the BFL retention period.

## A customer that leaves

Per /dpa point 13 the default is a read-only archive until the BFL retention
period ends. On a written request after export, delete everything that is not
räkenskapsinformation within 30 days. Posted vouchers and their documents
cannot be deleted before the retention period ends (the immutability triggers
forbid it); earlier deletion needs a separate agreement and a founder decision.

## Article master data

Article master records are not personal data and have no independent retention
duty. The delete endpoint allows deletion only when no invoice item references
the article. Issued invoice lines contain frozen descriptions, accounts, VAT
values, and amounts, while archived PDFs and journal records remain immutable.
This preserves the verification chain and the seven-year accounting retention
period even when an unused article master row is deleted.
