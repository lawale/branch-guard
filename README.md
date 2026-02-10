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
    check_type: enum           # file_presence | file_pair | external_status | branch_age
    on:
      branches: string[]       # Base branches this rule applies to
      paths:
        include: string[]      # Glob patterns that trigger the rule
        exclude: string[]      # Glob patterns to exclude (optional)
    config: object             # Check-type-specific (see below)
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

## Commands

Comment on a PR to trigger a recheck:

- `/recheck` — re-evaluate all BranchGuard rules for this PR
- `/branch-guard recheck` — same as above

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
| Pull Requests | Read | Fetch changed files |
| Metadata | Read | Default |

### Required Webhook Events

`pull_request`, `push`, `check_suite`, `check_run`, `issue_comment`

## Architecture

- **Stateless** — no database, all state from GitHub API + config file
- **Event-driven** — responds to webhooks, no polling loops
- **Cached** — 60s in-memory TTL cache for config and Git tree responses
- **Fault-tolerant** — each rule evaluation is isolated; one failure doesn't block others
- **Resilient** — automatic retry with exponential backoff for GitHub API rate limits (429, 403) and transient errors (5xx)

See [branch-guard-spec.md](branch-guard-spec.md) for the full technical specification.

## Contributing

Contributions are welcome. Please open an issue to discuss significant changes before submitting a PR.

```bash
npm install
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
