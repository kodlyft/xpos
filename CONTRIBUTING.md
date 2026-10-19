# Contributing to X POS

Thank you for your interest in contributing to X POS! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Choosing a Branch](#choosing-a-branch)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Fixing a PR That Targets the Wrong Branch](#fixing-a-pr-that-targets-the-wrong-branch)
- [Porting Maintenance Fixes (Maintainers)](#porting-maintenance-fixes-maintainers)
- [Reporting Bugs](#reporting-bugs)
- [Reporting Security Vulnerabilities](#reporting-security-vulnerabilities)
- [Requesting Features](#requesting-features)

## Code of Conduct

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Choosing a Branch

Pick the base branch **before** you start work. The branch you branch from and the branch your pull request targets must be the same.

| You are working on | Branch from | PR base |
| ------------------ | ----------- | ------- |
| A fix for the existing ERPNext v16 release (no breaking changes) | `version-16-hotfix` ⚠️ | `version-16-hotfix` |
| XPOS v3: the Pearl redesign, browser/PWA architecture changes, new features, or any breaking change | `develop` | `develop` |
| A security vulnerability | Do not open a public issue or PR. Follow [SECURITY.md](SECURITY.md). | n/a |

> ⚠️ **`version-16-hotfix` is not published yet.** Until it appears in [kodlyft/xpos](https://github.com/kodlyft/xpos/branches), open an issue describing your v16 fix before writing code, and a maintainer will tell you where to send it. Do not retarget a v16 fix to `develop` or another branch on your own.

`develop` is where XPOS v3 is being built. It is **not** a stable production release and may contain unfinished or breaking changes. Don't run it in production, and don't base fixes for the current v16 release on it.

Other branches in the repository (for example `version-15`) are not covered by this guide. Ask a maintainer before targeting them.

### Rules for maintenance (`version-16-hotfix`) PRs

Maintenance PRs must be safe to install on top of the existing v16 release. They must **not** introduce:

- breaking changes to whitelisted/public API methods (names, arguments, or response shape)
- breaking schema changes (removed or renamed DocTypes or fields, changed field types, or patches that rewrite existing data in a non-backward-compatible way)
- breaking changes to local/offline storage formats (IndexedDB, the Electron local database, or cached settings) that existing installs cannot read
- changes to established user workflows

If your fix needs any of these, it belongs in `develop` (XPOS v3). Open an issue to discuss it first.

## Getting Started

In this guide, **`upstream`** is the original repository (`kodlyft/xpos`) and **`origin`** is your personal fork. `bench get-app` names the cloned remote `upstream`, so install the app from the original repository and then add your fork:

1. **Fork** the repository on GitHub.
2. **Install the app** from the original repository:

   ```bash
   cd $PATH_TO_YOUR_BENCH
   bench get-app https://github.com/kodlyft/xpos.git --branch develop
   bench --site your-site.com install-app xpos
   ```

   For v16 maintenance work, use a bench and site running Frappe/ERPNext v16 that matches the release you are fixing.

3. **Add your fork** as the `origin` remote:

   ```bash
   cd apps/xpos
   git remote add origin https://github.com/<your-username>/xpos.git
   git remote -v   # upstream = kodlyft/xpos, origin = your fork
   ```

4. **Create a topic branch** from the correct upstream branch (see [Choosing a Branch](#choosing-a-branch)):

   ```bash
   git fetch upstream

   # XPOS v3 work
   git switch -c feat/your-feature-name upstream/develop

   # v16 maintenance fix (only once version-16-hotfix exists upstream)
   git switch -c fix/your-fix-name upstream/version-16-hotfix
   ```

   Never commit directly to your local `develop` or `version-16-hotfix`. Always use a topic branch.

## Development Setup

### Prerequisites

These are the current requirements for `develop` and the v16 release. Requirements for XPOS v3 have not been finalised and may change.

| Dependency       | Version  |
| ---------------- | -------- |
| Python           | >= 3.14  |
| Node.js          | >= 24    |
| Frappe Framework  | v16      |
| ERPNext          | v16      |

### Pre-commit Hooks

Install pre-commit hooks to ensure code quality before every commit:

```bash
cd apps/xpos
pip install pre-commit
pre-commit install
```

### Frontend Development

```bash
cd apps/xpos/frontend
yarn install
yarn dev          # Start Vite dev server
yarn test         # Run Vitest in watch mode
yarn test:run     # Run tests once
yarn typecheck    # TypeScript type checking
```

### Backend Development

```bash
cd $PATH_TO_YOUR_BENCH
bench start       # Start Frappe development server
```

## Making Changes

- Keep changes focused. A single PR should address a single concern, such as one bug or one feature.
- Don't mix in unrelated refactors, formatting sweeps, dependency bumps, or generated files. Open a separate PR for them.
- A maintenance PR should contain only the fix and its tests.
- Write or update tests for any new functionality.
- Run the same checks CI runs before submitting:

  ```bash
  cd apps/xpos

  # Python lint/format, semgrep rules, and file hygiene (pre-commit hooks)
  pre-commit run --all-files

  # Frontend type check and unit tests
  cd frontend
  yarn typecheck
  yarn test:run

  # Python unit tests (needs a test site with allow_tests enabled)
  cd $PATH_TO_YOUR_BENCH
  bench --site your-site.com set-config allow_tests true
  bench --site your-site.com run-tests --app xpos
  ```

## Commit Guidelines

All commits **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) specification. This enables automated versioning and changelog generation.

### Format

```
<type>(<optional scope>): <description>

[optional body]

[optional footer(s)]
```

### Allowed Types

| Type       | Description                              |
| ---------- | ---------------------------------------- |
| `feat`     | A new feature                            |
| `fix`      | A bug fix                                |
| `docs`     | Documentation only changes               |
| `style`    | Formatting, missing semicolons, etc.     |
| `refactor` | Code change that neither fixes nor adds  |
| `perf`     | Performance improvement                  |
| `test`     | Adding or updating tests                 |
| `build`    | Build system or dependency changes       |
| `ci`       | CI configuration changes                 |
| `chore`    | Other changes that don't modify src/test |
| `revert`   | Reverts a previous commit                |

### Examples

```
feat: add delivery charge calculation to cart
fix: correct tax rounding in multi-currency payments
docs: add offline mode troubleshooting guide
refactor(cart): simplify discount application logic
test: add unit tests for pricing engine
```

## Pull Request Process

1. **Sync your branch** with the latest upstream version of **your base branch**:

   ```bash
   git fetch upstream
   git rebase upstream/develop              # XPOS v3 work
   git rebase upstream/version-16-hotfix    # v16 maintenance fix
   ```

2. **Push** your topic branch to your fork:

   ```bash
   git push -u origin feat/your-feature-name
   # after a rebase, update the PR with:
   git push --force-with-lease
   ```

3. Open a Pull Request from your fork to `kodlyft/xpos`. In the **base** dropdown, choose the branch from [Choosing a Branch](#choosing-a-branch): `version-16-hotfix` for v16 maintenance, `develop` for XPOS v3. GitHub defaults to `develop`, so check this every time you open a v16 fix.

4. Fill out the PR template completely: what changed, why, the intended branch, how you validated it, and any compatibility or migration impact.

5. Ensure all CI checks pass (linting, type checking, tests, commit titles).

6. A maintainer will review your PR. Address any feedback and push updates to the same branch.

7. Once approved, a maintainer will merge your PR.

The PR template only reminds you to check the base branch. Nothing changes or enforces it automatically, so it is your responsibility to select the right one.

## Fixing a PR That Targets the Wrong Branch

**If only the PR base is wrong** (your branch was created from the correct upstream branch), click **Edit** next to the PR title on GitHub, pick the correct base branch, and save.

**If your branch was also created from the wrong base**, changing the base alone will pull unrelated commits into the PR. Move your commits onto the correct base first. For example, to move a v16 fix that was accidentally started from `develop`:

```bash
git fetch upstream
git rebase --onto upstream/version-16-hotfix upstream/develop fix/your-fix-name
git push --force-with-lease origin fix/your-fix-name
```

Then change the PR base on GitHub as above. If the rebase gets messy, create a fresh branch from the correct upstream branch, `git cherry-pick` only your commits, and open a new PR, closing the old one with a link to the new one.

## Porting Maintenance Fixes (Maintainers)

`version-16-hotfix` and `develop` are expected to diverge as XPOS v3 develops. Treat them as separate lines:

- When a maintenance fix is merged into `version-16-hotfix`, assess whether the same problem exists in `develop`.
- If it does, port the fix to `develop` **separately**, either by cherry-picking or by opening a dedicated PR that adapts the fix to v3 code. The repository's label-driven [Backport workflow](.github/workflows/backport.yml) can open that PR.
- If the affected code has been rewritten or removed in `develop`, note that on the original PR instead of forcing a port.
- Do not merge `develop` into `version-16-hotfix`, and do not merge whole branches into each other. Move individual fixes only.

Contributors only need to target the correct branch. They don't need to open the port themselves unless a maintainer asks.

## Reporting Bugs

Use the [Bug Report](https://github.com/kodlyft/xpos/issues/new?template=bug_report.md) issue template. Please include:

- Steps to reproduce
- Expected vs. actual behavior
- Screenshots or error logs if applicable
- Your environment (X POS version, Frappe/ERPNext version, browser, OS)

## Requesting Features

Use the [Feature Request](https://github.com/kodlyft/xpos/issues/new?template=feature_request.md) issue template. Describe:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Reporting Security Vulnerabilities

**Do not report security vulnerabilities through public issues, discussions, or pull requests.** Follow the private reporting process in [SECURITY.md](SECURITY.md).

---

Thank you for contributing to X POS!
