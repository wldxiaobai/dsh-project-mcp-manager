# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thanks for helping improve `dsh-project-mcp-manager`. Bug reports, docs fixes,
and code changes are all welcome.

## Before you start

- Small fixes (typos, docs, obvious bugs) can go straight to a pull request.
- For new features, behavior changes, new dependencies, or changes to the
  `projectMcp` service surface, open an
  [issue](https://github.com/wldxiaobai/dsh-project-mcp-manager/issues) first so
  we can agree on the approach.
- Keep one topic per pull request.

## Development setup

Requirements: Node.js and pnpm (the version is pinned in `package.json#packageManager`).
`pnpm-lock.yaml` is the only lock file; do not add `package-lock.json` or `yarn.lock`.

```powershell
pnpm install
pnpm run build     # core (src/ → lib/) then the UI package
pnpm test          # builds first, then runs test/*.mjs with node
```

To try your build in DSH, follow the source-checkout steps in the
[README](README.md#installation-mount-into-a-profile)
(`dsh plugin --profile <p> add link:<checkout>`), then rebuild after each change.
Use a separate profile or temporary `DSH_HOME` for testing.

## Pull request checklist

- Branch from `dev` and target `dev`. `main` is the stable branch and only
  receives releases from the maintainer.
- `pnpm run build` and `pnpm test` pass.
- Behavior changes and bug fixes come with tests under `test/` (plain `node`
  scripts, no test framework).
- User-visible changes update the docs in both languages: `README.md` and
  `docs/README.zh.md`, and the matching `docs/guide/*.md` / `*.zh.md` pair.
- Add an entry under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
- Do not bump versions in `package.json` or `packages/ui/package.json`; the
  maintainer does that at release time, keeping the manager and UI versions in sync.
- New dependencies use exact or tightly pinned versions, and the pull request
  explains why they are needed.
- Describe what changed and how you verified it (tests run, DSH version, platform).

## Code and commits

- TypeScript (ESM, `strict`). Match the surrounding style and reuse existing
  helpers instead of adding new libraries.
- [AGENTS.md](AGENTS.md) records the project's internal contracts (layer
  priority, effective names, session isolation, managed-file writes). Read the
  relevant part before changing `src/registry.ts`, `src/model.ts`, or file writers.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <subject>`, for example `fix(cli): 拒绝无效的 profile 名`.
  The repository history uses Chinese subjects; English subjects are also accepted.
- Keep each commit small and self-contained, so it builds and can be reviewed or
  reverted alone.

## Review and merging

- Please keep "Allow edits by maintainers" enabled. The maintainer may push
  follow-up fixes to your branch during review.
- Pull requests are merged with a merge commit, so your commits and authorship
  are kept. Contributors are credited in the CHANGELOG and the README.

## Security

`stdio` server entries spawn local commands, so changes around config loading,
`${VAR}` expansion, and managed-file writes get extra review. If you find a
security problem, do not open a public issue. Contact the maintainer privately
using the address in `package.json#author`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) of this project.
