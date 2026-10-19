<!--
Check the PR base branch before submitting. This template is only a reminder.
It does not change or enforce the base branch.

  Fix for the existing v16 release  ->  base: version-16-hotfix
  XPOS v3 development / breaking    ->  base: develop

Security vulnerabilities: do not open a PR. Follow SECURITY.md.
See CONTRIBUTING.md#choosing-a-branch for details.
-->

## Description

<!-- Summarise what changed and why. -->

## Intended Release / Branch

- [ ] Existing v16 release maintenance fix (base is `version-16-hotfix`)
- [ ] XPOS v3 development (base is `develop`)
- [ ] I have checked that the **base** branch selected above this PR matches my choice

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to change), `develop` only
- [ ] Documentation update
- [ ] Refactoring (no functional changes)

## Related Issue

Fixes #

## Validation Performed

- [ ] Pre-commit hooks pass (`pre-commit run --all-files`)
- [ ] Python unit tests pass (`bench --site <site> run-tests --app xpos`)
- [ ] Frontend unit tests pass (`cd frontend && yarn test:run`)
- [ ] TypeScript type check passes (`cd frontend && yarn typecheck`)
- [ ] Manual testing in browser
- [ ] Manual testing in Electron (if applicable)

<!-- Describe what you tested manually, and on which Frappe/ERPNext version. -->

## Compatibility / Migration Impact

<!--
Does this change any API, schema/DocType, patch, local/offline storage format, or user workflow?
If yes, describe the impact and any migration steps.
Maintenance PRs to version-16-hotfix must not include breaking changes.
-->

- [ ] No API, schema, storage, or workflow changes
- [ ] Includes changes described above (required for `develop`; not allowed for `version-16-hotfix` if breaking)

## Screenshots (if applicable)


## Checklist

- [ ] My code follows the project's coding style
- [ ] My commits follow the [Conventional Commits](https://www.conventionalcommits.org/) format
- [ ] I have added/updated tests for my changes (if applicable)
- [ ] I have updated documentation (if applicable)
- [ ] My changes do not introduce new warnings or errors
- [ ] This PR is focused on one concern and contains no unrelated changes
