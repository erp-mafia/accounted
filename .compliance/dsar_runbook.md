# Data Subject Rights Runbook

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

## Article master data

Article master records are not personal data and have no independent retention
duty. The delete endpoint allows deletion only when no invoice item references
the article. Issued invoice lines contain frozen descriptions, accounts, VAT
values, and amounts, while archived PDFs and journal records remain immutable.
This preserves the verification chain and the seven-year accounting retention
period even when an unused article master row is deleted.
