Seed the repository `$ARGUMENTS` with the pipeline's base files — its skills, workflows and scripts, and a base `CLAUDE.md` — so every later step, and every session opened in that repository, runs from files installed there.

This command is the **first step for a new idea**: run it in the clean repository the work will live in, before `/roadmap` or the `brief-to-proposals` workflow (which runs it for you). It copies the pipeline's `.claude/commands/` (its skills), any `.claude/skills/`, `.claude/workflows/` and `.claude/scripts/` from a source checkout, and writes a `CLAUDE.md` that says how work happens in this repository, with a `## Pipeline config` section `/bootstrap` later completes from the accepted architecture. It writes files only: no commit, no branch, no push. On a greenfield repository the seeded files ship in the bootstrap PR, so `main` carries them before any milestone builds; on an existing repository they ship in an ordinary PR (`/create-pr`).

## Arguments

`$ARGUMENTS` is a space-separated list of tokens:

- `<target>` — the repository to seed (default: the working directory).
- `--from=<dir>` — the pipeline source: a directory whose `.claude/` holds the pipeline (a checkout of the pipeline, or a project that has it installed). Default: the working directory. It must contain `.claude/workflows/brief-to-proposals.js` and `.claude/scripts/proposal-lint.py` → else `error=no_source`, naming what is missing and asking for `--from`. Files are copied as they are on disk; when the source is a git checkout with uncommitted changes (modified or untracked files) in what is copied, the report lists them (the target then gets an unreleased version).
- `--update` — also replace pipeline files in the target that differ from the source (upgrading an installed pipeline). Never touches `CLAUDE.md`.
- `--dry-run` — print what would be copied, kept and written; write nothing.

An unrecognized `--`-prefixed token or a second target → `error=invalid_argument`. Source and target resolving to the same directory (for example no `--from`, run in a repository that already holds the pipeline) → nothing to copy: only *Write CLAUDE.md* runs.

## Check the target

1. `git -C <target> rev-parse --show-toplevel` must succeed → else `error=not_a_repo` (the pipeline assumes a clean repository is already set up; it never creates one). Work at that root.
2. `git -C <target> remote get-url origin` must succeed → else `error=no_remote`.
3. Tracked files with uncommitted changes (`git status --porcelain`, lines not starting `??`) → `error=dirty_tree`, listing them. Untracked files (a brief, notes, design docs) are fine.
4. **Greenfield or existing**, exactly as `/roadmap` judges it (its *Greenfield vs existing* rule): the target is **existing** when `CLAUDE.md` has a `## Pipeline config` other than the one this command writes (marked `<!-- Pipeline config written by /seed -->`), or it holds source code, manifests or CI config outside `.git/`, `.claude/`, the design docs and the brief; otherwise it is **greenfield** (a host's initial `README`, `LICENSE` and `.gitignore` are fine, and so is everything this command writes, so a re-run never changes the verdict). The next step and the `QUALITY_GATES` candidate below depend on it.

## Copy the pipeline files

For each of `.claude/commands/`, `.claude/skills/` (when the source has it), `.claude/workflows/` and `.claude/scripts/`, every regular file under it in the source, to the same path in the target. When the source is a git checkout, the files are the ones `git -C <source> ls-files --cached --others --exclude-standard -- <dir>` lists, so caches and anything else the source ignores never ship; otherwise skip `__pycache__/` and `*.pyc`. Never follow a symlink.

- **Absent** in the target → copy it, keeping its file mode.
- **Identical** → nothing to do.
- **Different** → keep the target's version and list it as *differs*; under `--update`, replace it and list it as *updated*.

Never delete a target file, and copy nothing else (no `settings.local.json`, no source `CLAUDE.md`, no caches such as `__pycache__/`). Copy `.claude/settings.json` only when the target has none.

## Write CLAUDE.md

- **No `CLAUDE.md`** → write one (atomically: write `CLAUDE.md.tmp.<pid>` beside it, `<pid>` being your shell's, then rename it into place). `<repository name>` is the repo root's directory name:

  ```md
  # <repository name>

  <!-- Written by /seed. /bootstrap completes the Pipeline config and adds Invariants and Testing from the accepted architecture. -->

  This repository is designed and built with a Claude Code pipeline. The design lives in `docs/design/`: `architecture.md`, `roadmap.md` and one proposal per milestone. Changes reach `main` only through pull requests.

  ## How work happens here

  - A product brief or large change goes through `/roadmap`, `/propose` and `/review-proposal` (the `brief-to-proposals` workflow runs them) before any code.
  - Design docs are drafts until a person sets `Status: accepted`; nothing is built from a draft.
  - Every human-gated step (research, decisions, accounts and secrets, releases) is done and ticked by a person, with its `Outcome:` recorded.
  - Code is built lane by lane with `proposal-build-chain` and `plan-to-merged-pr`; never push to `main`, never force-push; a person merges.
  - Secrets are named, never written down: values live in the CI secret store, the host's secret manager, or a gitignored `.env`.

  ## Pipeline config

  <!-- Pipeline config written by /seed -->
  MAIN_BRANCH: main
  PROPOSALS_DIR: docs/design
  ```

  No `QUALITY_GATES` yet: there is nothing to gate until `/bootstrap` writes the skeleton, and a placeholder would be run as a command. `/plan` and `/impl` say so until then.
- **An existing `CLAUDE.md`** → keep every line, and append at the end of the file, each with its full body as above: the `## How work happens here` section if it has no such heading, then the `## Pipeline config` section if it has none. An existing Pipeline config is never edited.
- **An existing repository** whose Pipeline config (old or new) has no `QUALITY_GATES`: report the commands its CI runs (from `.github/workflows/` or the equivalent) as the candidate value, for a person to add once they pass locally. A greenfield repository gets its gates from `/bootstrap`.

## Report

    Seeded: <target> from <source>

Then: files copied, identical, differing (kept) or updated, per directory; whether `CLAUDE.md` was written, appended to or left alone; the candidate `QUALITY_GATES` for an existing repository. Close with the next step: `/roadmap <brief>` or the `brief-to-proposals` workflow for a new product (the seeded files are committed with `/bootstrap`'s branch), or `/create-pr` to land them in an existing repository.

## What to skip

- Do not commit, stage, branch, push or open a PR; write nothing outside the target's `.claude/`, `CLAUDE.md` and its `CLAUDE.md.tmp.<pid>`.
- Do not write `QUALITY_GATES`, invariants or testing rules — `/bootstrap` derives them from the accepted architecture.
- Do not enter plan mode or invoke other commands.

## Safety

- Never overwrite a target file without `--update`, never overwrite `CLAUDE.md` content, never delete anything.
- Copy only the pipeline directories named above and, when the target has none, `.claude/settings.json`; never copy secrets, `.env` files or `settings.local.json`.
