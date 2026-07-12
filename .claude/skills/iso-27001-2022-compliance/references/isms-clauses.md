# ISMS Clauses 4-10: Mandatory Documents and Verification Logic

ISO/IEC 27001:2022 is structurally bifurcated. Annex A enumerates security controls; Clauses 4-10 define the management system that must wrap them. Certification fails without a complete and operating Management System, regardless of how well Annex A controls are implemented technically.

The clauses are: Context (4), Leadership (5), Planning (6), Support (7), Operation (8), Performance Evaluation (9), Improvement (10). Each produces required documented information that the agentic auditor must locate and evaluate.

## Mandatory documents per clause

| Clause | Document | Filename convention | Verification logic |
|---|---|---|---|
| 4.3 | Scope of the ISMS | `ISMS_Scope.md` | Must define exact boundaries: included departments, locations, systems, exclusions with justification. |
| 5.2 | Information Security Policy | `InfoSec_Policy.md` | Must include framework for objectives, commitment to satisfy applicable requirements, commitment to continual improvement, top management approval. |
| 6.1.2 | Risk Assessment Process | `Risk_Methodology.md` | Must define scoring matrix (impact × likelihood), risk acceptance thresholds, owner assignment criteria. |
| 6.1.3 | Statement of Applicability | `SoA.json` / `SoA.csv` | Must contain four core elements per control: identifier, inclusion/exclusion statement, justification, implementation status. |
| 6.2 | Information Security Objectives | `Security_Objectives.md` | Must contain measurable, time-bound goals with assigned owners. |
| 7.2 | Evidence of Competence | `Competency_Matrix.csv` | Records of training, qualifications, certifications. Cross-reference with HRIS where possible. |
| 7.5 | Documented Information control | (cross-cutting) | Every document must have classification mark-up, version table, sign-off, review date within annual interval. |
| 8.2 | Risk Assessment Results | `Risk_Register.xlsx` | Active ledger. Every entry must have risk owner, residual risk score, treatment decision. |
| 8.3 | Risk Treatment Plan | `Risk_Treatment.md` | Must align with Risk Register and SoA. Every accepted risk must be referenced. |
| 9.1 | Performance evaluation results | `KPI_Dashboard.md` or equivalent | Metrics on ISMS effectiveness. |
| 9.2 | Internal Audit Programme + Results | `Internal_Audit_Log.md` | Dates, auditors (independent from auditee), findings, non-conformities, corrective actions. |
| 9.3 | Management Review minutes | `Mgmt_Review_Minutes.md` | Must show executive participation and cover the mandatory inputs (see below). |
| 10.1 | Continual improvement | (cross-cutting) | Evidence of corrective actions closing previous findings. |
| 10.2 | Nonconformity and corrective action records | `NC_Log.md` or `NC_Register.xlsx` | Each NC must have root cause analysis, corrective action, effectiveness verification. |

## Clause 9.3: Mandatory Management Review inputs

This is the most commonly under-documented requirement. Management Review minutes must explicitly cover **all** of the following:

1. Status of actions from previous management reviews.
2. Changes in external and internal issues relevant to the ISMS.
3. Changes in needs and expectations of interested parties.
4. Feedback on information security performance, including:
   a. Nonconformities and corrective actions.
   b. Monitoring and measurement results.
   c. Audit results.
   d. Fulfilment of information security objectives.
5. Feedback from interested parties.
6. Results of risk assessment and status of risk treatment plan.
7. Opportunities for continual improvement.

The agentic auditor must verify each of these is textually present. Output a per-input checklist showing pass/fail for each agenda item.

## Clause 7.5: Documented Information requirements

Every controlled document must satisfy:

| Requirement | Verification logic |
|---|---|
| Title and identifier | Regex check for unique document ID. |
| Date of issue / last revision | Regex check + freshness check (within annual interval). |
| Version number | Regex check for semantic versioning or sequential numbering. |
| Classification mark-up | Regex search for "Confidential", "Internal Use Only", "Public" tokens. |
| Author / approver | Regex check for sign-off section. |
| Approval evidence | Cross-reference with version control history (Git blame for last approver). |

Documents missing any of these elements are deterministic violations of Clause 7.5, separate from any content-quality issues.

## Document quality vs document existence

The agentic auditor must distinguish two failure modes:

1. **Existence failure**: Document is missing entirely. Deterministic.
2. **Adequacy failure**: Document exists but content does not meet the clause requirements. Probabilistic, requires LLM evaluation.

Adequacy failures are more common than existence failures in mature organizations. A `Mgmt_Review_Minutes.md` may exist as a file but fail to mention 5 of the 7 mandatory Clause 9.3 inputs. The deterministic check passes; the agentic check fails.

Always run both checks and report them separately.

## Boilerplate detection

Be especially alert to AI-generated boilerplate. Common red flags:

- Generic language with no organizational specificity (no team names, no system names, no actual numbers).
- Missing contextual references to the organization's actual systems, products, or geography.
- Inconsistent voice or tense across sections.
- Identical phrasing to template repositories on GitHub.

Boilerplate documents technically satisfy existence checks but fail adequacy. Flag as Observation, not Non-Conformity, since they can be remediated by genuine documentation work.

## Cross-clause consistency checks

The auditor must run cross-references:

| Check | Source A | Source B | Failure mode |
|---|---|---|---|
| Risk Register entries → SoA controls | Risk_Register | SoA | Risk references control X but SoA excludes X without justification linking to compensating controls. |
| Risk Treatment Plan → Risk Register | Risk_Treatment | Risk_Register | Treatment references risk ID not in register. |
| SoA inclusions → InfoSec_Policy | SoA | InfoSec_Policy | Policy claims commitments not reflected in SoA inclusions. |
| Internal Audit findings → NC Log | Internal_Audit_Log | NC_Log | Audit identified NC but no entry in NC log. |
| Competency Matrix → InfoSec roles | Competency_Matrix | Roles defined in policies | Role exists in policy but no competency requirement defined. |
| Suppression Risk IDs → Risk Register | Inline scanner suppressions | Risk_Register | Suppression references Risk ID that does not exist. |

These cross-checks are the highest-value agentic operations because they detect compliance theater: where every individual document looks fine but the documents are internally inconsistent.
