# Contributing

Thanks for helping improve Workspace Guard.

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
