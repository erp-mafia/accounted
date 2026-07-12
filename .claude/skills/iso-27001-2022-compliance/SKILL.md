---
name: iso-27001-2022-compliance
description: Authoritative reference for verifying ISO/IEC 27001:2022 compliance from a code repository. Use whenever a task involves auditing, automating, or generating evidence for ISO 27001 controls, the ISMS document set (Clauses 4-10), the Statement of Applicability (SoA), or Annex A controls (A.5 Organizational, A.6 People, A.7 Physical, A.8 Technological). Trigger on mentions of ISO 27001, ISO/IEC 27001, 27001:2022, ISMS, SoA, Annex A, "Statement of Applicability", a specific control identifier (A.5.x, A.6.x, A.7.x, A.8.x), Checkov/Trivy/Steampipe ISO compliance specs, the 2013-to-2022 control transition, NIST 800-53 / CIS Controls / SOC 2 crosswalks, agentic auditing of policy documents, or building CI/CD pipeline gates for security compliance. Trigger even when phrasing is indirect ("is our Terraform compliant", "scan our policies for audit readiness", "what does the standard require for cryptography", "map our controls to SOC 2", "build a compliance scanner"), these all qualify.
---

# ISO/IEC 27001:2022 Compliance Verification Skill

## Purpose

This skill provides authoritative, repository-grounded reference data for two distinct verification modes against ISO/IEC 27001:2022:

1. **Deterministic CI/CD scanning**: Pull-Request-time evaluation of code, IaC, and dependency manifests against Annex A.8 (Technological Controls).
2. **Agentic auditing**: On-demand semantic review of ISMS policy documents (Clauses 4-10) and organizational controls (Annex A.5).

The skill is designed for engineers building compliance automation, not for end-user training. It is a compliance oracle: when in doubt about what the standard actually requires, consult this skill rather than relying on memory.

## Why two modes exist

ISO 27001:2022 is structurally bifurcated. Clauses 4-10 govern the management system (governance, scope, leadership, planning, operation, performance, improvement) and are expressed in natural-language documents. Annex A enumerates 93 security controls, the majority of which (the 34 in A.8) map directly to repository artifacts. Deterministic parsers handle A.8; LLM-based agentic auditors handle Clauses 4-10 and A.5. A.7 (Physical) and most of A.6 (People) sit out-of-repo and require evidence pointers, not direct verification.

## Routing: read this first

Before consulting any reference file, identify which mode the task requires:

- Task touches Terraform, CloudFormation, Kubernetes manifests, Dockerfiles, application source code, package manifests, CI/CD definitions, or branch protection → **deterministic mode**. Read `references/annex-a-controls.md` and `references/violation-patterns.md`.
- Task touches Markdown policies, the Information Security Policy, Risk Register, SoA, Management Review minutes, internal audit logs → **agentic mode**. Read `references/isms-clauses.md` and `references/agentic-prompts.md`.
- Task asks about new controls introduced in the 2022 revision → read `references/new-controls-2022.md`.
- Task references a 2013-era control identifier (e.g., A.14.2.1, A.12.1.2) → read `references/legacy-mapping.md` to translate before responding.
- Task involves NIST 800-53, CIS Controls v8.1, or SOC 2 → read `references/cross-framework-mapping.md`.
- Task involves wrapping Checkov, Trivy, or Steampipe → read `references/tool-orchestration.md`.

## The Statement of Applicability is the routing table

Never apply all 93 Annex A controls blindly. Compliance is governed by the organization's SoA (Clause 6.1.3d), which declares which controls are included, which are excluded, and the justification for each. A machine-readable SoA (`soa.json` or `soa.csv`, conventionally located at `.security/` or `ISMS/`) is the primary input to any compliance scan. If the SoA is missing, the first finding is always: "Cannot determine control applicability: Clause 6.1.3 violation."

A valid SoA contains four core elements per control:
1. The control identifier and title.
2. A statement of inclusion or exclusion.
3. Justification (operational reasoning for inclusion, risk-based reasoning for exclusion).
4. Implementation status (Implemented, Planned, Not Applicable).

Suppression logic for the scanner:
- Excluded controls → suppress all checks. Do not generate findings.
- Included + Implemented → run all checks. Failures are blocking.
- Included + Planned → run all checks. Failures are warnings, not blocking.
- Included + Not Applicable → structural contradiction. Flag as SoA inconsistency.

## Three verification typologies

Every Annex A control falls into one of three categories. Be explicit about which one applies before claiming a control has been verified.

### Deterministic in-repo
Structured parsing produces a binary outcome. Examples: A.8.24 (encryption flags in IaC), A.8.4 (branch protection rules), A.8.8 (CVEs in dependency manifests), A.8.28 (SAST presence in pipelines). These are the highest-leverage targets for automation.

### Agentic over policy artifacts
Constrained LLM evaluation of natural-language documents. Examples: Clause 5.2 (Information Security Policy adequacy), Clause 9.3 (Management Review completeness), A.5.1 (Policies for information security), A.5.7 (Threat Intelligence: does the documented threat-intel process actually address the control intent?). The LLM produces "Observations" and "Potential Non-Conformities" for human validation. Never autonomous decisions.

### Out-of-repo / evidence pointer
Cannot be verified from the repository alone. Examples: A.7.x (all Physical Controls), A.6.1 (Screening), A.6.4 (Disciplinary process). The skill's job is to confirm that the policy exists AND that the policy contains a pointer (URL, API reference, named system of record) to the external evidence source. If both the policy and the pointer are absent, flag a documentation gap. Never claim the underlying control is "verified."

## Trigger mechanics for CI/CD integration

The scanner must select sub-modules based on the Git diff to avoid running the full audit on trivial commits:

| Files changed | Modules to run |
|---|---|
| `*.tf`, `*.yml`, `*.yaml`, `*.json`, `Dockerfile`, K8s manifests | Checkov (IaC) → A.8.9, A.8.20, A.8.22, A.8.24, A.8.27 |
| `package-lock.json`, `requirements.txt`, `go.sum`, `Cargo.lock`, `pom.xml` | Trivy (SCA) → A.8.8, A.8.30 |
| Application source code | SAST + secret scanning → A.8.24, A.8.28 |
| `.github/workflows/*`, `.gitlab-ci.yml` | Pipeline integrity → A.8.25, A.8.29, A.8.31, A.8.32 |
| `ISMS/**/*.md`, `ISMS/**/*.docx`, `*.md` policies | Agentic LLM auditor → Clauses 4-10, A.5.x |
| `soa.json`, `soa.csv` | SoA structural validation → Clause 6.1.3 |

## Suppression and risk acceptance: the critical coupling

Inline suppressions in scanner output (e.g., `# checkov:skip=CKV_AWS_19`) are legitimate only when paired with a documented, executive-approved Risk Register entry. The scanner must enforce this coupling:

1. Parse suppression comments for a Risk ID reference.
2. Cross-reference the Risk ID against the canonical Risk Register (Clause 8.2 artifact, typically `Risk_Register.xlsx` or equivalent).
3. Verify the entry exists, has a Risk Owner, has a residual risk score, and is referenced in the Risk Treatment Plan (Clause 8.3).
4. If any of these are missing, the suppression is invalid. Generate a Clause 6.1.3 finding regardless of the technical check passing.

This mechanism is the binding contract between developer behavior and GRC oversight. Without it, suppressions become a compliance laundering mechanism.

## Honest limitations: surface these proactively

Automated scanners cannot prove physical reality, behavioral compliance, or runtime state. When generating reports, label every finding with its verification scope:

- "Documentation Verified: Physical Validation Required" for A.7.x policies.
- "Policy Verified: Behavioral Compliance Out of Scope" for A.6.3 (training), A.7.7 (clear desk).
- "Point-in-Time" for any deterministic check. Continuous runtime monitoring (A.8.16) is required to detect drift after merge.

For agentic AI workflows in the audited system itself, reference the OWASP Top 10 for Agentic Applications and demand heightened governance controls. Standard SOC 2 / ISO 27001 controls assume deterministic systems and are insufficient for autonomous agents.

Read `references/limitations.md` for the full catalog of what automation cannot verify and how to communicate this to auditors.

## Required ISMS directory structure

Expect (and enforce) this canonical layout:

```
ISMS/
├── Governance/
│   ├── ISMS_Scope.md              (Clause 4.3)
│   ├── InfoSec_Policy.md          (Clause 5.2)
│   └── Security_Objectives.md     (Clause 6.2)
├── Risk/
│   ├── Risk_Methodology.md        (Clause 6.1.2)
│   ├── Risk_Register.xlsx         (Clause 8.2)
│   └── Risk_Treatment.md          (Clause 8.3)
├── SoA/
│   └── SoA.json                   (Clause 6.1.3)
├── Competence/
│   └── Competency_Matrix.csv      (Clause 7.2)
└── Audits/
    ├── Internal_Audit_Log.md      (Clause 9.2)
    └── Mgmt_Review_Minutes.md     (Clause 9.3)
```

For each document, beyond existence, verify: classification mark-up (Confidential / Internal Use Only), version control table, executive sign-off, review timestamp within the declared annual interval. Missing metadata is a Clause 7.5 (Documented Information) violation.

## Output report structure

Every compliance scan output should follow this template so findings are auditor-defensible:

```
# ISO/IEC 27001:2022 Compliance Report
## Repository: <name> | Commit: <sha> | SoA Version: <version> | Date: <ISO>

## Summary
- Controls in scope (per SoA): <N>
- Findings: <critical> critical, <high> high, <medium> medium, <low> low
- Documentation gaps: <N>
- Suppression integrity: <pass/fail>

## Findings by Annex A theme
### Organizational Controls (A.5)
### People Controls (A.6)
### Physical Controls (A.7)
### Technological Controls (A.8)

## ISMS Clause Findings (4-10)

## Cross-framework mapping (if requested)
- NIST SP 800-53 Rev. 5
- CIS Controls v8.1
- SOC 2 TSC

## Verification scope disclaimer
- Point-in-time scan of commit <sha>
- Out-of-repo controls verified by evidence pointer only
- Behavioral compliance not in scope
```

## Reference files

- `references/annex-a-controls.md`: Full catalog of Annex A.5, A.6, A.7, A.8 with verification logic per control.
- `references/new-controls-2022.md`: The 11 net-new controls in the 2022 revision and their automation implications.
- `references/legacy-mapping.md`: 2013 → 2022 control identifier translation matrix.
- `references/isms-clauses.md`: Clauses 4-10 mandatory documents and content expectations.
- `references/violation-patterns.md`: Real-world code, configuration, and dependency violation patterns with detection logic.
- `references/cross-framework-mapping.md`: NIST 800-53 Rev. 5, CIS Controls v8.1, SOC 2 TSC crosswalks.
- `references/tool-orchestration.md`: Checkov / Trivy / Steampipe wrapping patterns, including custom YAML policies.
- `references/agentic-prompts.md`: Constrained LLM prompts for policy and management review evaluation.
- `references/limitations.md`: Catalog of what automation cannot verify and required disclaimers.
