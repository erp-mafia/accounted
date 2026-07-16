# Data Classification and Handling

## Restricted data

Swedish personal identity numbers are Restricted personal data. They are not an
Article 9 special category by themselves, but their stable government identifier
role requires heightened protection.

Controls:

- Customer personal numbers are accepted only for individual customers.
- Values are encrypted with AES-256-GCM before database storage.
- API and UI output exposes only the last four digits.
- Writes require an authenticated company member with write permission.
- RLS and explicit `company_id` filters enforce tenant isolation.
- There is no endpoint that returns the full value.
- Logs and audit event payloads must never contain the full value.

## Internal business data

Article master records are Internal business data. An unused article may be
deleted because issued invoice lines, archived invoice PDFs, journal entries,
and audit events retain the accounting evidence independently. Any article that
is referenced by an invoice line is protected by the application check and the
database foreign key.
