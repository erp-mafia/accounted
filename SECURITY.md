# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in Accounted, please report it responsibly. **Do not open a public issue.**

Email: **security@arcim.io**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Scope

The following areas are in scope for security reports:

- **Authentication and authorization** -- Supabase auth, RLS policies, API route guards
- **Accounting data integrity** -- journal entry immutability, period lock enforcement, balance validation
- **Document retention** -- 7-year retention enforcement, deletion prevention
- **API routes** -- injection, authorization bypass, data leakage
- **Extension system** -- privilege escalation, sandbox escape

## Response Timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 7 days
- **Fix for critical issues**: within 30 days
- **Public disclosure**: coordinated with the reporter after the fix is released

## Safe Harbor

We will not pursue legal action against security researchers who:

- Act in good faith to avoid harm to users and data
- Report vulnerabilities promptly and do not exploit them beyond what is necessary to demonstrate the issue
- Do not access, modify, or delete other users' data
- Follow the reporting process described above
