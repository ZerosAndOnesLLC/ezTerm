# Contributing to ezTerm

Thanks for considering a contribution. ezTerm is an open-source SSH client
built with Rust + Tauri; PRs and issues are welcome.

## Before you start

- Browse [open issues](https://github.com/ZerosAndOnesLLC/ezTerm/issues) — if
  what you want to work on isn't there, open one first so we can agree on
  shape and scope before code lands.
- For non-trivial features, expect to write a short spec under
  `docs/superpowers/specs/` and an implementation plan under
  `docs/superpowers/plans/` before the code review. The repo's recent feature
  branches show the pattern.
- Security-sensitive changes: see [SECURITY.md](SECURITY.md). Don't open
  public issues for vulnerabilities.

## Dev quickstart

See the [Dev quickstart](README.md#dev-quickstart) section of the README for
toolchain setup and how to run the app. The short version:

```bash
cp .env.example .env
npm --prefix ui install
cargo tauri dev
```

## Before opening a PR

- `cargo check` must pass clean (no warnings; remove unused code, don't
  `#[allow(...)]` past warnings).
- `cargo test --manifest-path src-tauri/Cargo.toml` passes.
- `npm --prefix ui run typecheck` and `npm --prefix ui run lint` pass.
- Bump `Cargo.toml` version per the convention: major = breaking, minor =
  features, patch = fixes. Site/docs-only commits don't bump.
- Migrations are added with `sqlx migrate add` so the timestamp is correct,
  and tested with `sqlx migrate run` before commit.

## Commit messages

Conventional Commits — examples from recent history:

- `feat(ssh-forwards): EADDRINUSE friendly msg, async-error toasts`
- `fix(site): use relative markdown links for internal doc cross-references`
- `docs(release-notes): v1.3.4`
- `sec(ssh-forwards): bind_addr parse-check at save`

No `Co-Authored-By` or "Made with X" attribution in commit messages.

## UI changes

ezTerm's look-and-feel target is **MobaXterm** — left Sessions sidebar,
tabbed terminal area, optional SFTP side-pane, dark by default with a light
toggle. Conventions, tokens, and component patterns live in
`docs/design/`. Match existing styles; don't introduce new visual languages
without an explicit design update.

## Site / docs changes

The public site (`site/`) is Astro + Starlight. See
[`site/README.md`](site/README.md) for the dev loop. Docs land at
[ezterm gh-pages site](https://zerosandonesllc.github.io/ezTerm/docs/).

## Questions

Open a [Discussion](https://github.com/ZerosAndOnesLLC/ezTerm/discussions)
for usage Q&A or feature ideas, an [Issue](https://github.com/ZerosAndOnesLLC/ezTerm/issues)
for confirmed bugs.
