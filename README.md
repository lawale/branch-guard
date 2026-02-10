# BranchGuard

Programmable branch protection for GitHub. A GitHub App that runs configurable checks on pull requests based on which files changed.

BranchGuard is not a CI runner. It evaluates conditions using the GitHub API and posts pass/fail check runs. Define rules in a YAML config file, and BranchGuard enforces them automatically.

## Use Cases

- **Migration sync** — Block PRs that are missing database migrations present on the base branch
- **Lockfile consistency** — Require `package-lock.json` updates when `package.json` changes
- **Changelog enforcement** — Require `CHANGELOG.md` updates when source code changes
- **Conditional CI** — Only require lint/typecheck status checks when relevant files change
- **Proto sync** — Ensure protobuf files haven't diverged from the base branch
- **Stale branch detection** — Fail PRs from branches that diverged more than N days ago
- **Team approval gates** — Require approving reviews from specific teams or users when certain files change

## Quick Start

1. Install the BranchGuard GitHub App on your repository
2. Create `.github/branch-guard.yml` in your repo's default branch:

```yaml
rules:
  - name: lockfile-check
    description: "package-lock.json must be updated when package.json changes"
    check_type: file_pair
    on:
      branches: [main]
      paths:
        include:
          - "package.json"
    config:
      companion: "package-lock.json"
```

3. Open a PR — BranchGuard will post check runs based on your rules

## Configuration

All configuration lives in `.github/branch-guard.yml` on your repository's default branch.

### Rule Schema

```yaml
rules:
  - name: string              # Unique ID (lowercase alphanumeric + hyphens)
    description: string        # Shown in check run output
    check_type: enum           # file_presence | file_pair | external_status | branch_age | approval_gate
    on:
      branches: string[]       # Base branches this rule applies to
      paths:
        include: string[]      # Glob patterns that trigger the rule
        exclude: string[]      # Glob patterns to exclude (optional)
    config: object             # Check-type-specific (see below)
    failure_message:           # Optional custom failure output
      title: string            # Override default failure title
      summary: string          # Override default failure summary
    notify: boolean            # Post PR comment on failure (default: true)
```

Rules are limited to 20 per config file. Each rule produces a check run named `branch-guard/{ruleName}`.

## Check Types

### `file_presence`

Ensures all files matching a pattern on the base branch also exist on the head branch. Useful for detecting missing migrations or diverged files.

```yaml
- name: migration-sync
  description: "Ensure PR has all base branch migrations"
  check_type: file_presence
  on:
    branches: [main, dev]
    paths:
      include: ["**/Migrations/**/*.cs"]
      exclude: ["**/*.Designer.cs", "**/*Snapshot.cs"]
  config:
    mode: base_subset_of_head
```

| Config Field | Type | Description |
|---|---|---|
| `mode` | enum | `base_subset_of_head` — all matching base files must exist on head |

### `file_pair`

When trigger files change, companion files must also be updated.

```yaml
- name: lockfile-check
  description: "package-lock.json must update when package.json changes"
  check_type: file_pair
  on:
    branches: [main]
    paths:
      include: ["frontend/package.json"]
  config:
    companion: "frontend/package-lock.json"
```

| Config Field | Type | Description |
|---|---|---|
| `companion` | string or string[] | File path(s) that must also be changed |
| `mode` | enum | `any` (default) — at least one companion. `all` — every companion. |

### `external_status`

Makes another check run conditionally required. When matching files change, the specified checks must pass. When no matching files change, this check auto-passes.

```yaml
- name: lint-check
  description: "Frontend changes must pass lint"
  check_type: external_status
  on:
    branches: [main, dev]
    paths:
      include: ["frontend/src/**/*.ts", "frontend/src/**/*.tsx"]
  config:
    required_checks:
      - "frontend-lint"
      - "frontend-typecheck"
    timeout_minutes: 30
```

| Config Field | Type | Description |
|---|---|---|
| `required_checks` | string[] | Check run names that must pass |
| `timeout_minutes` | number | Timeout in minutes (default: 30) |

BranchGuard uses a hybrid approach: it listens for `check_run.completed` webhooks to resolve pending checks reactively, with fallback re-evaluation on PR updates.

### `branch_age`

Fails if the PR branch diverged from the base branch more than a configurable number of days ago. Encourages developers to keep branches fresh and rebased.

```yaml
- name: stale-branch
  description: "Branch must not be older than 14 days"
  check_type: branch_age
  on:
    branches: [main]
    paths:
      include: ["**/*"]
  config:
    max_age_days: 14
```

| Config Field | Type | Description |
|---|---|---|
| `max_age_days` | number | Maximum allowed age in days (branch age <= limit passes) |

BranchGuard uses the GitHub Compare API to determine the merge base commit date. If the branch diverged more than `max_age_days` ago, the check fails with a message suggesting a rebase.

### `approval_gate`

Requires approving PR reviews from specific teams or users when matching files change. Works like CODEOWNERS but scoped per-rule with configurable team/user requirements.

```yaml
- name: api-approval
  description: "API changes require backend team approval"
  check_type: approval_gate
  on:
    branches: [main]
    paths:
      include: ["api/**"]
  config:
    required_teams:
      - backend-team
```

With multiple requirements and `mode: all`:

```yaml
- name: security-approval
  description: "Security changes require all reviewers"
  check_type: approval_gate
  on:
    branches: [main]
    paths:
      include: ["security/**", "auth/**"]
  config:
    required_teams:
      - security
    required_users:
      - security-lead
    mode: all
```

| Config Field | Type | Description |
|---|---|---|
| `required_teams` | string[] | Team slugs whose members can approve (optional) |
| `required_users` | string[] | GitHub usernames who can approve (optional) |
| `mode` | enum | `any` (default) — at least one requirement met. `all` — every requirement met. |
| `auto_request_reviewers` | boolean | Auto-request missing reviewers on the PR when the check fails (default: `false`) |

At least one of `required_teams` or `required_users` must be provided. The check evaluates the latest review from each reviewer — if any required reviewer has requested changes, the check fails regardless of other approvals. Username matching is case-insensitive. The check re-evaluates on PR sync or `/recheck`.

When `auto_request_reviewers` is enabled, BranchGuard automatically requests review from the missing teams/users on the PR. Only missing reviewers are requested — already-approved teams/users are skipped. Reviewers are not requested when the failure is due to changes being requested (those reviewers already know). GitHub handles overlapping team memberships gracefully (no duplicate notifications).

> **Note:** Requires the **Organization Members: Read** permission to resolve team memberships, and **Pull Requests: Read & Write** when `auto_request_reviewers` is enabled.

## Custom Failure Messages

Any rule can include an optional `failure_message` to override the default failure output with team-specific guidance:

```yaml
rules:
  - name: migration-sync
    description: "Ensure PR has all base branch migrations"
    check_type: file_presence
    on:
      branches: [main]
      paths:
        include: ["**/Migrations/**/*.cs"]
    config:
      mode: base_subset_of_head
    failure_message:
      title: "Missing migrations — rebase required"
      summary: "This PR is missing migration files from main. See wiki/migrations for help."
```

| Field | Type | Description |
|---|---|---|
| `failure_message.title` | string | Replaces the default failure title (optional) |
| `failure_message.summary` | string | Replaces the default failure summary (optional) |

Both fields are optional — you can override just the title, just the summary, or both. Custom messages only apply on failure; success output is always the check type's default.

## Allowing File Deletions

When using `file_presence` with `mode: base_subset_of_head`, the check fails if a file exists on the base branch but is missing on the head branch. If the deletion is intentional, you can add an allowlist to the PR description.

Add an HTML comment block in the PR body:

```
<!-- branch-guard:allow
rule-name: path/to/file.sql (reason for deletion)
rule-name: path/to/other.sql (another reason)
-->
```

- Each line: `rule-name: file-path (optional reason)`
- The rule name must match the `name` field in your config
- File paths must be exact matches (not glob patterns)
- The reason in parentheses is optional but recommended for reviewers
- The block must be inside an HTML comment so it doesn't render in the PR

**Example:**

```
<!-- branch-guard:allow
migration-sync: db/migrations/001_init.sql (replaced by consolidated migration)
migration-sync: db/migrations/002_users.sql (merged into 003)
-->
```

When allowed files are present, the check passes but reports the overrides in the check run details so reviewers can verify the deletions are appropriate. Editing the PR body triggers an automatic re-evaluation.

> **Note:** The allowlist only applies to `file_presence` checks.

## PR Comment Notifications

GitHub does not send notifications for third-party check run failures. BranchGuard compensates by posting a sticky PR comment when any check fails, so the PR author is always notified.

- **One comment per PR** — BranchGuard finds its own comment by a hidden marker and updates it in place. The first failure creates the comment (triggering a GitHub notification); subsequent evaluations update it silently.
- **Recheck link** — Failure comments include a direct link to the PR comment box so you can quickly post `/recheck`.
- **Success update** — When all previously failing checks pass, the comment is updated to show all checks resolved.
- **Opt-out per rule** — Set `notify: false` on a rule to exclude it from the PR comment. The check run itself still runs; only the comment notification is suppressed.

```yaml
rules:
  - name: internal-check
    description: "This check runs silently"
    check_type: file_presence
    on:
      branches: [main]
      paths:
        include: ["internal/**"]
    config:
      mode: base_subset_of_head
    notify: false
```

> **Note:** Requires the **Issues: Write** permission to post and update PR comments.

## Commands

Comment on a PR to trigger a recheck:

- `/recheck` — re-evaluate all BranchGuard rules for this PR
- `/branch-guard recheck` — same as above

The `/recheck` comment is automatically deleted after processing to keep the PR timeline clean.

## Self-Hosting

### Environment Variables

| Variable | Description |
|---|---|
| `APP_ID` | GitHub App ID |
| `PRIVATE_KEY` | GitHub App private key (PEM format) |
| `WEBHOOK_SECRET` | Webhook secret for payload verification |
| `WEBHOOK_PROXY_URL` | Smee.io URL (local dev only) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default: `info`) |
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | `production` / `development` |

### Docker

```bash
docker build -t branch-guard .
docker run -p 3000:3000 --env-file .env branch-guard
```

### Fly.io

1. Install the [Fly CLI](https://fly.io/docs/flyctl/install/)
2. Launch the app:

```bash
fly launch --no-deploy
```

3. Set secrets:

```bash
fly secrets set APP_ID="your-app-id" \
  PRIVATE_KEY="$(cat private-key.pem)" \
  WEBHOOK_SECRET="your-webhook-secret" \
  NODE_ENV="production"
```

4. Deploy:

```bash
fly deploy
```

The `Dockerfile` is auto-detected. Set your GitHub App's webhook URL to `https://<your-app>.fly.dev/api/github/webhooks`.

### Local Development

```bash
# 1. Create a GitHub App (use Smee.io for webhook forwarding)
# 2. Copy .env.example to .env and fill in your credentials
cp .env.example .env

# 3. Install and run
npm install
npm run dev
```

### Running Tests

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
npm run typecheck   # Type-check without emitting
```

## GitHub App Permissions

### Required Permissions

| Permission | Access | Purpose |
|---|---|---|
| Checks | Read & Write | Create and update check runs |
| Contents | Read | Fetch config file and Git trees |
| Pull Requests | Read & Write | Fetch changed files/reviews; request reviewers (`auto_request_reviewers`) |
| Issues | Write | Post and update PR comment notifications |
| Organization Members | Read | Resolve team memberships (for `approval_gate`) |
| Metadata | Read | Default |

### Required Webhook Events

`pull_request`, `pull_request_review`, `push`, `check_suite`, `check_run`, `issue_comment`

## Architecture

- **Stateless** — no database, all state from GitHub API + config file
- **Event-driven** — responds to webhooks, no polling loops
- **Cached** — 60s in-memory TTL cache for config and Git tree responses
- **Fault-tolerant** — each rule evaluation is isolated; one failure doesn't block others
- **Resilient** — automatic retry with exponential backoff for GitHub API rate limits (429, 403) and transient errors (5xx)
- **Branch protection compatible** — always creates a passing check run for every rule, even when no files match, so rules can be safely marked as required status checks
- **Installation backfill** — automatically evaluates all open PRs when the app is first installed, so existing PRs don't get stuck with missing checks

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a PR.

```bash
npm install
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
