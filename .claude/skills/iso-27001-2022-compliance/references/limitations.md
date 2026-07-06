# Honest Limitations of Automated ISO 27001:2022 Compliance Verification

The skill is an aid to certification, not a substitute. A scanner that overpromises destroys audit credibility. Surface these limitations in every report.

## Limitation 1: Physical reality

No code execution can verify physical reality. The scanner can confirm a policy says "server room doors must be locked" (A.7.2) or "premises shall be monitored" (A.7.4). It cannot confirm that any physical door is actually locked or that any actual camera is recording.

**Required disclaimer in reports**:
> "Physical Controls (A.7.x) verified by documentation only. Physical validation requires on-site inspection and is out of scope for repository-based scanning."

## Limitation 2: Behavioral compliance

Human behavior is opaque to scanners. Several controls require people to actually do things, not just for the documentation to require it.

| Control | What scanner can verify | What scanner cannot verify |
|---|---|---|
| A.6.3 Awareness training | LMS API shows completion | Whether the employee understood the material |
| A.7.7 Clear desk and clear screen | Policy exists, screen lock GPO/MDM enforced | Whether actual desks are clear, whether passwords are written on post-its |
| A.6.6 NDAs | Template exists | Whether all employees have signed |
| A.5.10 Acceptable use | Policy exists | Whether employees follow it |

**Required disclaimer**:
> "Behavioral compliance is out of scope. Verification requires walkthroughs, interviews, and observation by human auditors."

## Limitation 3: Point-in-time scans vs continuous compliance

A repository can pass all checks at PR-merge time and immediately drift out of compliance through:
- Manual changes via cloud console (clickops).
- Resources created outside IaC (e.g., emergency hotfixes).
- Configuration changes by SaaS vendors (e.g., default settings changing in a managed service).
- Credentials rotated outside the documented process.

This violates A.8.9 (Configuration management) and A.8.16 (Monitoring) by definition. Mitigation requires continuous runtime monitoring (Steampipe queries on a schedule, AWS Config rules, Azure Policy, GCP Organization Policy), not just CI/CD-time scans.

**Required disclaimer**:
> "This is a point-in-time assessment of commit <sha>. Production state may have drifted from this commit. Continuous runtime monitoring (A.8.16) is required to detect post-merge drift."

## Limitation 4: Document existence vs adequacy

The scanner can prove a file exists. It can apply LLM evaluation to assess whether the file's content meets normative requirements. It cannot prove that the document is current, that the listed approvers actually approved it, or that the procedures described are actually followed.

The agentic auditor produces "Observations" that require human validation. Adequacy claims are not certifications.

**Required disclaimer**:
> "Agentic policy review is advisory. Findings labeled 'Observation' or 'Potential Non-Conformity' require validation by a qualified human auditor."

## Limitation 5: Agentic AI in the audited system itself

If the audited system uses AI agents in production (e.g., LLM-based workflows, autonomous decision-making, MCP-server-driven automation), traditional ISO 27001 controls are insufficient.

Issues:
- A.8.28 (Secure coding) was written for deterministic code. LLM behavior is probabilistic.
- A.8.32 (Change management) assumes changes are deployable artifacts. Prompt or retrieval changes may bypass this.
- A.5.7 (Threat intelligence) does not cover prompt injection or jailbreaking.
- A.8.29 (Security testing) does not specify adversarial robustness testing.

Reference: OWASP Top 10 for Agentic Applications, Agentic Trust Framework. The scanner should:
1. Detect presence of agentic AI components (LLM API calls, MCP servers, autonomous agents).
2. Demand additional documented governance for autonomy boundaries.
3. Flag standard SOC 2 / ISO 27001 audit reports as insufficient for autonomous systems.

**Required disclaimer when agentic AI detected**:
> "This system uses agentic AI components. Standard ISO 27001:2022 controls do not adequately address probabilistic and autonomous system behavior. Reference OWASP Top 10 for Agentic Applications and supplement with agent-specific governance controls."

## Limitation 6: Out-of-repo systems

Many controls depend on systems outside the repository: HRIS, IdP, MDM, ticketing, badge access. The scanner can verify policy + evidence pointers, but not the state of external systems unless explicit API integration is configured (e.g., Steampipe with appropriate plugins).

When external API integration is unavailable, mark the control as "Documentation Verified: System of Record Not Queried" rather than "Verified".

## Limitation 7: SoA dependency

The scanner is only as accurate as the SoA. A SoA that excludes critical controls without justification will cause the scanner to skip checks that should be running. The agentic auditor must evaluate the SoA's exclusion justifications, but ultimately the SoA reflects organizational decisions that the scanner cannot override.

If the SoA is missing, malformed, or includes obviously inappropriate exclusions, generate a Clause 6.1.3 finding and refuse to issue a "compliant" verdict regardless of technical scan results.

## Limitation 8: Certification body discretion

ISO 27001 certification is issued by accredited certification bodies, not by automated tools. A clean scanner output is not a certificate. Certification bodies apply professional judgment, conduct interviews, perform sampling, and examine evidence in ways that cannot be fully automated.

The skill produces audit-defensible evidence and identifies probable findings. It does not certify.

**Required language**:
> "This report is internal evidence to support the organization's information security management system. It is not an ISO 27001 certificate. Certification requires audit by an accredited certification body."

## Limitation 9: Accuracy of cross-framework mappings

NIST 800-53 Rev. 5, CIS Controls v8.1, and SOC 2 TSC are independent frameworks. ISO 27001 mappings are approximations. A control passing in ISO does not automatically pass in another framework. Privacy is the largest gap (see `cross-framework-mapping.md`).

**Required disclaimer when generating dual-framework reports**:
> "Cross-framework mappings are approximations. Each framework has unique requirements that may not be covered by ISO 27001 alone. Specifically, NIST 800-53 Rev. 5 Privacy (PT) family and SOC 2 Privacy criteria require supplementary controls beyond ISO 27001."

## Limitation 10: False negatives in static analysis

SAST tools have known false-negative rates. Custom detection patterns, novel vulnerabilities, business-logic flaws, and authorization bypasses often escape pattern matching. Achieving high pass rates on the scanner does not prove the absence of vulnerabilities; it proves the absence of detected vulnerabilities.

A.8.29 (Security testing) requires testing methods beyond SAST: DAST, IAST, manual penetration testing, threat modeling. The scanner can verify these are scheduled and that reports exist; it cannot replace them.

---

## Summary table for report generators

| Verification claim | Strength | Required disclaimer |
|---|---|---|
| "EBS volume encrypted (A.8.24)" | Strong | None for the IaC fact; add point-in-time disclaimer for the runtime state. |
| "Branch protection enabled (A.8.4)" | Strong | None. |
| "Information Security Policy adequate (Clause 5.2)" | Moderate | Agentic / human review required. |
| "Physical perimeter secured (A.7.1)" | Weak | Documentation only. Physical validation required. |
| "Awareness training completed (A.6.3)" | Weak | LMS records verify completion, not comprehension. |
| "Configuration drift detected" | Strong | Requires Steampipe runtime querying. |
| "ISO 27001:2022 compliant" | **Never claim this** | Certification is the certification body's determination. |

The skill can claim "evidence of conformance with <specific clauses or controls>". It cannot claim "compliant".
