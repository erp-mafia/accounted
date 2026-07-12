# Violation Patterns: Code, Configuration, Dependency

This file catalogs concrete violation patterns the scanner must detect. Patterns are organized by where they live in the repository: source code, infrastructure-as-code, or dependency manifests.

For each pattern: the violation, the controls violated, and the detection logic.

---

## Code-level violations

### SQL injection via string concatenation
**Controls violated**: A.8.28 (Secure coding), A.8.3 (Information access restriction).
**Pattern**:
```python
query = "SELECT * FROM users WHERE id = " + user_input
cursor.execute(query)
```
**Detection**: SAST rule (Semgrep, CodeQL) flagging string concatenation into SQL execution functions. Compare to parameterized form `cursor.execute("SELECT * FROM users WHERE id = %s", (user_input,))`.

### Command injection via shell concatenation
**Controls violated**: A.8.28.
**Pattern**:
```python
os.system("ping " + user_input)
subprocess.call(f"git clone {repo_url}", shell=True)
```
**Detection**: SAST rule for `os.system`, `subprocess.*` with `shell=True` and unsanitized inputs.

### Hardcoded secrets
**Controls violated**: A.8.24 (Use of cryptography), A.5.17 (Authentication information).
**Pattern**:
```python
AWS_SECRET_KEY = "AKIAIOSFODNN7EXAMPLE"
db_password = "p@ssw0rd123"
```
**Detection**: Entropy analysis + regex (Trivy secret scanner, gitleaks, truffleHog). Scan full Git history, not just current HEAD: secrets in old commits are still exposed.

### Weak cryptography
**Controls violated**: A.8.24.
**Patterns**:
```python
import hashlib
hashlib.md5(password.encode())  # Broken
hashlib.sha1(password.encode())  # Broken
```
```javascript
crypto.createHash('md5')  // Broken
```
**Detection**: SAST rule for MD5, SHA-1, DES, RC4, ECB mode, or hashing without salt for password storage. Required alternatives: SHA-256+ for hashing, bcrypt/argon2/scrypt for passwords.

### Missing input validation on PII handlers
**Controls violated**: A.8.11 (Data masking), A.5.34 (Privacy and protection of PII).
**Pattern**: Functions that accept PII parameters and write them to logs, return them in error messages, or store them unencrypted.
**Detection**: Tag-based SAST: annotate PII-handling functions and verify masking/redaction is applied before output sinks (logs, errors, storage).

### Insecure deserialization
**Controls violated**: A.8.28.
**Patterns**:
```python
pickle.loads(user_input)
yaml.load(user_input)  # Without SafeLoader
```
**Detection**: SAST rule for known-unsafe deserializers with untrusted input.

### Path traversal
**Controls violated**: A.8.3, A.8.28.
**Pattern**:
```python
open(os.path.join(base_dir, user_provided_filename))
```
**Detection**: SAST rule for filesystem operations using unsanitized user input. Required guard: realpath check that resolved path is within base_dir.

---

## Configuration-level violations (IaC)

### Public storage buckets
**Controls violated**: A.8.12 (DLP), A.8.3 (Access restriction), A.5.34.
**Patterns**:
```hcl
resource "aws_s3_bucket" "data" {
  acl = "public-read"
}
```
```hcl
resource "aws_s3_bucket_public_access_block" "data" {
  block_public_acls = false
  block_public_policy = false
}
```
**Detection**: Checkov CKV_AWS_53, CKV_AWS_54, CKV_AWS_55, CKV_AWS_56.

### Wildcard IAM permissions
**Controls violated**: A.8.2 (Privileged access rights).
**Pattern**:
```json
{
  "Effect": "Allow",
  "Action": "*",
  "Resource": "*"
}
```
**Detection**: Checkov CKV_AWS_1, CKV_AWS_46, CKV_AWS_49. JSON path query for any policy statement with `Action: *` AND `Resource: *`. Some narrow exceptions exist (e.g., `iam:GetUser` on self) but `*:*` is never justifiable.

### Unencrypted storage
**Controls violated**: A.8.24.
**Patterns**:
```hcl
resource "aws_ebs_volume" "data" {
  encrypted = false  # Or omitted (default false in older provider versions)
}

resource "aws_db_instance" "main" {
  storage_encrypted = false
}
```
**Detection**: Checkov CKV_AWS_3 (EBS), CKV_AWS_16 (RDS), CKV_AWS_17 (RDS publicly accessible), CKV_AWS_19 (S3 server-side encryption).

### Database in public subnet
**Controls violated**: A.8.20 (Network security), A.8.22 (Segregation of networks).
**Pattern**: RDS / managed database resource attached to a subnet whose route table has a route to an Internet Gateway, plus a security group allowing 0.0.0.0/0 ingress on the database port.
**Detection**: Graph-based check (Checkov supports this via cross-resource attribute queries).

### Unrestricted security group ingress
**Controls violated**: A.8.20, A.8.22.
**Pattern**:
```hcl
resource "aws_security_group" "open" {
  ingress {
    from_port = 0
    to_port = 65535
    cidr_blocks = ["0.0.0.0/0"]
  }
}
```
**Detection**: Checkov CKV_AWS_24 (port 22 / SSH from 0.0.0.0/0), CKV_AWS_25 (port 3389 / RDP), generic checks for all-port ingress from 0.0.0.0/0.

### Missing TLS enforcement
**Controls violated**: A.8.20, A.8.24.
**Patterns**:
```hcl
resource "aws_lb_listener" "http" {
  protocol = "HTTP"  # Should be HTTPS
  port = 80
}
```
S3 buckets without bucket policy denying non-HTTPS requests.
**Detection**: Checkov CKV_AWS_2 (ALB listener HTTPS), CKV_AWS_103 (TLS 1.2+ for ALB), CKV_AWS_91 (ALB access logging).

### Privileged containers
**Controls violated**: A.8.18 (Use of privileged utility programs).
**Pattern**:
```yaml
spec:
  containers:
    - name: app
      securityContext:
        privileged: true
        runAsUser: 0
        capabilities:
          add: ["SYS_ADMIN"]
```
**Detection**: Checkov CKV_K8S_16, CKV_K8S_20, CKV_K8S_22.

### Missing resource limits
**Controls violated**: A.8.6 (Capacity management).
**Pattern**: Kubernetes containers without `resources.limits.cpu` and `resources.limits.memory`.
**Detection**: Checkov CKV_K8S_10, CKV_K8S_11, CKV_K8S_12, CKV_K8S_13.

### Missing logging
**Controls violated**: A.8.15 (Logging).
**Pattern**: AWS resources without CloudTrail enabled, S3 buckets without access logging, VPCs without flow logs.
**Detection**: Checkov CKV_AWS_67 (CloudTrail multi-region), CKV_AWS_18 (S3 access logging), CKV_AWS_11 (VPC flow logs).

### Unprotected branch
**Controls violated**: A.8.4 (Access to source code), A.8.32 (Change management).
**Pattern**: GitHub `main` / `master` branch without protection rules requiring PR review, status checks, and signed commits.
**Detection**: Steampipe query against GitHub API, or scan of `.github/settings.yml` if probot/settings is used.

---

## Dependency-level violations

### Known CVEs in production dependencies
**Controls violated**: A.8.8 (Management of technical vulnerabilities), A.8.30 (Outsourced development).
**Detection**: Trivy / Snyk / Dependabot scanning `package-lock.json`, `requirements.txt`, `go.sum`, `Cargo.lock`, `pom.xml`, `Gemfile.lock`, `composer.lock`. Threshold: any CVSS ≥ 7.0 with available patch is blocking.

### Unpinned dependencies
**Controls violated**: A.8.8, A.8.32.
**Patterns**:
```
# requirements.txt
requests
django>=3.0
```
```json
// package.json
"lodash": "^4.0.0"
```
**Detection**: Manifest parsing for version specifiers using `>=`, `^`, `~`, or no version. Floating versions break reproducibility and audit trail.

### Missing lockfile
**Controls violated**: A.8.32 (Change management).
**Pattern**: `package.json` without `package-lock.json`, `requirements.txt` without `requirements.lock` or `Pipfile.lock`.
**Detection**: Filesystem check.

### Abandoned / unmaintained dependencies
**Controls violated**: A.8.8, A.8.30.
**Detection**: Cross-reference dependency list with deps.dev / libraries.io / OSV to detect packages with no commits in >24 months.

### License risk
**Controls violated**: A.5.32 (Intellectual property rights).
**Detection**: License scanner (FOSSA, Black Duck, license-checker) flagging GPL-3.0, AGPL-3.0, SSPL where they conflict with the repository's own licensing strategy.

### Typosquatting / dependency confusion
**Controls violated**: A.8.30, A.5.21 (ICT supply chain).
**Detection**: Known-bad-package lists, registry mirror verification, internal package namespace enforcement.

---

## Pipeline-level violations

### SAST not in pipeline
**Controls violated**: A.8.28, A.8.29.
**Detection**: Parse `.github/workflows/*.yml` and `.gitlab-ci.yml`. Verify a SAST step (Semgrep, CodeQL, SonarQube, Snyk Code) runs on every PR targeting protected branches.

### SCA not in pipeline
**Controls violated**: A.8.8.
**Detection**: As above, for SCA steps (Trivy, Snyk, Dependabot, OWASP Dependency-Check).

### IaC scanner not in pipeline
**Controls violated**: A.8.9, A.8.27.
**Detection**: As above, for IaC scanning (Checkov, tfsec, Terrascan).

### Secret scanning not in pipeline
**Controls violated**: A.8.24, A.5.17.
**Detection**: As above, for secret scanning (gitleaks, truffleHog, GitHub native secret scanning).

### No environment separation
**Controls violated**: A.8.31 (Separation of dev/test/prod).
**Pattern**: Single Terraform state file or single AWS account hosting both staging and production resources.
**Detection**: Workspace / state file inspection. Account ID checks across environment-specific variable files.

### Auto-merge bypassing review
**Controls violated**: A.8.4, A.8.32.
**Pattern**: GitHub auto-merge enabled on PRs without required reviewers, or CODEOWNERS not enforced.
**Detection**: Repository settings via Steampipe or GitHub API.
