# Contributing

Thanks for helping improve Workspace Guard.

## Contribution Requirements

Acceptable contributions should follow these project requirements:

- Keep changes focused on one problem or feature.
- Preserve the project's privacy-first and offline-first behavior by default.
- Do not add telemetry, phone-home behavior, background network access, or remote execution without an explicit opt-in and clear documentation.
- Add or update tests when behavior changes.
- Update user-facing docs when commands, UI, settings, or review behavior change.
- Keep GitHub Actions pinned and use least-privilege permissions.
- Explain security, trust, or workflow risk clearly in the pull request when a change affects `.github`, shell execution, workspace safety, settings backup, or secrets handling.

## Coding Standard

Please follow these implementation expectations:

- Write TypeScript that matches the existing project style and naming patterns.
- Prefer small, readable functions over broad refactors.
- Keep changes compatible with the project's current Node and VS Code engine requirements.
- Avoid unnecessary dependencies.
- Prefer deterministic tests and keep smoke-test coverage passing when Explorer or command flows change.

## Development Flow

1. Create a branch from `main`.
2. Make the smallest focused change you can.
3. Run the local quality gates:
   - `npm test`
   - `npm run build`
   - `npm run test:smoke`
4. Open a pull request with a short summary, validation notes, and any risk tradeoffs.
5. Wait for CI to pass before merging.

## Pull Request Expectations

- Keep changes scoped to one topic.
- Update tests when behavior changes.
- Update docs when user-facing behavior changes.
- Prefer pinned GitHub Actions and least-privilege workflow permissions.
- Do not add telemetry, phone-home behavior, or network access without an explicit opt-in.

## Security-Sensitive Changes

Take extra care with:

- `.github/workflows/*`
- `.github/dependabot.yml`
- workspace path handling
- shell execution
- settings backup and rollback logic

If a change affects trust, automation, or secrets handling, explain the risk in the pull request.
