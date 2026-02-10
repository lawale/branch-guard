# Privacy Policy

**Effective date:** February 2026

BranchGuard is a GitHub App that evaluates branch protection rules on pull requests. This policy describes how BranchGuard handles data.

## Data We Access

BranchGuard accesses the following data through the GitHub API, solely to evaluate your configured rules:

- **Repository configuration** — the `.github/branch-guard.yml` file on your default branch
- **Pull request metadata** — PR number, head/base branch, changed files, and PR description
- **Git file trees** — file paths at specific commit SHAs (to compare base and head branches)
- **PR reviews** — reviewer identities and review states (for `approval_gate` rules)
- **Team memberships** — organization team member lists (for `approval_gate` rules)
- **Check runs** — existing check run statuses (for `external_status` rules)

## Data We Store

**BranchGuard does not store any user data.** The application is entirely stateless, there is no database, no file storage and no persistent state of any kind.

The only caching is an in-memory TTL cache (60 seconds) for configuration files and Git tree responses. This cache exists solely to reduce redundant GitHub API calls and is lost whenever the application restarts.

## Data We Share

**BranchGuard does not share any data with third parties.** The application communicates only with the GitHub API and does not integrate with any external services, analytics platforms or tracking systems.

## Cookies and Tracking

BranchGuard does not use cookies, browser storage, analytics or any form of user tracking. It is a server-side webhook handler with no user-facing interface.

## Data Security

All communication with the GitHub API is encrypted via HTTPS. Webhook payloads are verified using a shared secret to ensure authenticity. The application does not log or persist any sensitive data such as tokens, credentials or personal information.

## Your Rights

Since BranchGuard does not collect or store personal data, there is no personal data to access, modify or delete. You can uninstall the GitHub App at any time, which immediately revokes all API access.

## Changes to This Policy

If this policy changes, the updated version will be published in this repository with an updated effective date.

## Contact

If you have questions about this policy, please open an issue in the [BranchGuard repository](https://github.com/lawale/branch-guard).
