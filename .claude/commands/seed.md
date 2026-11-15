Seed the repository `$ARGUMENTS` with the pipeline's base files — its skills, workflows and scripts, and a base `CLAUDE.md` — so every later step, and every session opened in that repository, runs from files installed there.

This command is the **first step for a new idea**: run it in the clean repository the work will live in, before `/roadmap` or the `brief-to-proposals` workflow (which runs it for you). It copies the pipeline's `.claude/commands/` (its skills), any `.claude/skills/`, `.claude/workflows/` and `.claude/scripts/` from a source checkout, and writes a `CLAUDE.md` that says how work happens in this repository, with a `## Pipeline config` section `/bootstrap` later completes from the accepted architecture. It writes files only: no commit, no branch, no push. On a greenfield repository the seeded files ship in the bootstrap PR, so `main` carries them before any milestone builds; on an existing repository they ship in an ordinary PR (`/create-pr`).

## Arguments

`$ARGUMENTS` is a space-separated list of tokens:

- `<target>` — the repository to seed (default: the working directory).
- `--from=<dir>` — the pipeline source: a directory whose `.claude/` holds the pipeline (a checkout of the pipeline, or a project that has it installed). Default: the working directory. It must contain `.claude/workflows/brief-to-proposals.js` and `.claude/scripts/proposal-lint.py` → else `error=no_source`, naming what is missing and asking for `--from`. Files are copied as they are on disk; when the source is a git checkout with uncommitted changes (modified or untracked files) in what is copied, the report lists them (the target then gets an unreleased version).
- `--update` — upgrade an installed pipeline: replace pipeline files the target has not edited since they were installed, and delete ones the source no longer ships (see *Copy the pipeline files*). Never touches `CLAUDE.md`.
- `--force` — with `--update`: also take the source's version of a file edited both in the target and in the source (a *conflict*), or of one that has no install record and matches no version the source ever shipped (*differs*).
- `--dry-run` — print what would be copied, kept and written; write nothing.

An unrecognized `--`-prefixed token, a second target, or `--force` without `--update` → `error=invalid_argument`. Source and target resolving to the same directory (for example no `--from`, run in a repository that already holds the pipeline) → nothing to copy: *Check the target* and *Write CLAUDE.md* still run; only *Copy the pipeline files* is skipped.

## Check the target

1. `git -C <target> rev-parse --show-toplevel` must succeed → else `error=not_a_repo` (the pipeline assumes a clean repository is already set up; it never creates one). Work at that root.
2. `git -C <target> remote get-url origin` must succeed → else `error=no_remote`.
3. Tracked files outside the target's `.claude/` and `CLAUDE.md` with uncommitted changes (`git status --porcelain`, lines not starting `??`) → `error=dirty_tree`, listing them. Changes inside them are fine: this command only ever writes there, so they are an earlier run's, which a re-run sees again (`brief-to-proposals` seeds again an existing repository seeded a moment before). Untracked files (a brief, notes, design docs) are fine too.
4. **Greenfield or existing**, exactly as `/roadmap` judges it (its *Greenfield vs existing* rule): the target is **existing** when `CLAUDE.md` has a `## Pipeline config` other than the one this command writes (marked `<!-- Pipeline config written by /seed -->`), or it holds source code, manifests or CI config outside `.git/`, `.claude/`, the design docs and the brief; otherwise it is **greenfield** (a host's initial `README`, `LICENSE` and `.gitignore` are fine, and so is everything this command writes, so a re-run never changes the verdict). The next step and the `QUALITY_GATES` candidate below depend on it.

## Copy the pipeline files

Run the deterministic installer from the source, never by hand when it exists:

    python3 <source>/.claude/scripts/pipeline-sync.py --target <target> --from <source> --json [--update [--force]] [--dry-run]

It copies, for each of `.claude/commands/`, `.claude/skills/` (when the source has it), `.claude/workflows/` and `.claude/scripts/`, every regular file under it in the source to the same path in the target (when the source is a git checkout, the files `git ls-files --cached --others --exclude-standard` lists, so caches and anything else the source ignores never ship; otherwise skipping `__pycache__/` and `*.pyc`; never following a symlink), keeping file modes, and `.claude/settings.json` only when the target has none. It records what it installed in `.claude/pipeline-manifest.json` (the source's repo, ref and commit, and the sha256 of each file as the source shipped it), so a later `--update` compares three ways:

- **Absent** in the target → copied (*added*), unless the manifest shows it was installed and someone deleted it (*removed_locally*: kept deleted).
- **Identical** → nothing to do.
- **Unedited since install, changed in the source** → *outdated*; under `--update`, replaced (*updated*).
- **Edited in the target, unchanged in the source** → *local_edit*: kept.
- **Edited in both** → *conflict*: kept; under `--update --force`, replaced.
- **Different, with no install record** (a pipeline copied by hand, before the manifest) → looked up in the source's git history: identical to a version some commit shipped → an unedited older version, *outdated* (and listed as *adopted*), with that version recorded as its base; else *differs*: it may hold local edits, so it is kept, as a conflict is; under `--update --force`, replaced.
- **Recorded, but no longer in the source** → *obsolete*; under `--update`, deleted when unedited (*deleted*), else kept (*obsolete_edited*).

Exit 2 (`error`) → stop and report it. When the source has no `pipeline-sync.py` (an older pipeline), apply the same rules by hand without a manifest: copy what is absent, keep what differs unless `--update`, delete nothing.

**An existing `.claude/settings.json`** (the target had one, so `settings_json_copied` is false) is never edited, by an install or an `--update`. Compare it with the source's: when it lacks the source's `statusLine` or any of its hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop` and `PreCompact`, each running `.claude/scripts/context-guard.py`, the context guard that has the orchestrating session hand off before its context passes 50%), report the missing entries as a JSON snippet, copied from the source's file, for a person to merge by hand. A target with a `statusLine` of its own can keep it: the hooks still work without the guard's status line, measuring the context from the session transcript.

## Write CLAUDE.md

- **No `CLAUDE.md`** → write one (atomically: write `CLAUDE.md.tmp.<pid>` beside it, `<pid>` being your shell's, then rename it into place). `<repository name>` is the repo root's directory name. The `## How work happens here` section is the pipeline's template, `<source>/.claude/scripts/claude-md-base.md`, copied verbatim with its marker comment (`<!-- How work happens here written by /seed ... -->`): `pipeline-sync.py` compares a marked section with the template of the pipeline it syncs from and reports the difference (it never edits `CLAUDE.md`). When the source has no `claude-md-base.md` (an older pipeline), write that section as the source's own `/seed` gives it.

  ```md
  # <repository name>

  <!-- Written by /seed. /bootstrap completes the Pipeline config and adds Invariants and Testing from the accepted architecture. -->

  This repository is designed and built with a Claude Code pipeline. The design lives in `docs/design/`: `architecture.md`, `roadmap.md` and one proposal per code milestone. After the first commit, changes reach `main` only through pull requests.

  <the ## How work happens here section: the whole of <source>/.claude/scripts/claude-md-base.md, verbatim>

  ## Pipeline config

  <!-- Pipeline config written by /seed -->
  MAIN_BRANCH: main
  PROPOSALS_DIR: docs/design
  ```

  No `QUALITY_GATES` yet: there is nothing to gate until `/bootstrap` writes the skeleton, and a placeholder would be run as a command. `/plan` and `/impl` say so until then.
- **An existing `CLAUDE.md`** → keep every line, and append at the end of the file, each with its full body as above: the `## How work happens here` section (the template, with its marker) if it has no such heading, then the `## Pipeline config` section if it has none. An existing Pipeline config is never edited.
- **An existing repository** whose Pipeline config (old or new) has no `QUALITY_GATES`: report the commands its CI runs (from `.github/workflows/` or the equivalent) as the candidate value, for a person to add once they pass locally. A greenfield repository gets its gates from `/bootstrap`.
- **An existing repository with no AI review check** (no CI workflow that reviews pull requests and posts comments — an action or app such as `answerable-ai-review`, `claude-code-action` or a code-review bot): report that the PR monitor will see only human comments and CI, and offer the pipeline's `examples/answerable-ai-review.yml` and `examples/answerable-ai-review-replies.yml` (at `<source>/examples/` when the source has them, else in the repository `.claude/pipeline-manifest.json` records): copy both to `.github/workflows/`, add the secret `CLAUDE_CODE_OAUTH_TOKEN` by NAME (`gh secret set CLAUDE_CODE_OAUTH_TOKEN` prompts for the value; never write one down), pass `ai_review_check: 'Review'` to the workflows, and require the check `Reply coverage` to make unanswered findings block merge. `'Review'` is the check's name only when the example workflow is copied unchanged: it is the `name:` of its review job. A greenfield repository gets the offer from `/bootstrap`'s next steps.
- **A repository that has an AI review check**: its name is a fact the tree settles, so read it and never ask a person to confirm it. Open the review workflow's file: the check name is the review job's `name:`, or the job's key when it has no `name:`. When the repository has a pull request with check runs and GitHub is reachable (`gh`, else the GitHub MCP tools), compare the name with those check runs and report the one they show, saying so when the two differ. Report it as the `ai_review_check` value.

## Report

    Seeded: <target> from <source>

Then: files added, identical, updated, deleted, and those kept back (outdated, differs, local edits, conflicts, obsolete) per directory, and the source commit installed (and the one it replaced); whether `.claude/settings.json` was copied, and, when the target's own lacks the context guard's entries, the snippet to merge; whether `CLAUDE.md` was written, appended to or left alone, and, when its `## How work happens here` section differs from the template, the sync report's `claude_md` status and diff, for a person to apply by hand (an existing section is never edited); the candidate `QUALITY_GATES` for an existing repository, and its AI review check (the `ai_review_check` value as read from the workflow file, stated as a fact with the file and job it came from and never as something to confirm, or the offer above when it has none). On a first install, add that the pipeline keeps its handoff, lane plans and review ledgers on origin's `pipeline/state` branch, which the first save creates (a rule that blocks pushing new branches to origin blocks it too). Close with the next step: `/roadmap <brief>` or the `brief-to-proposals` workflow for a new product (the seeded files are committed with `/bootstrap`'s branch), or `/create-pr` to land them in an existing repository.

## What to skip

- Do not commit, stage, branch, push or open a PR; write nothing outside the target's `.claude/`, `CLAUDE.md` and its `CLAUDE.md.tmp.<pid>`.
- Do not write `QUALITY_GATES`, invariants or testing rules — `/bootstrap` derives them from the accepted architecture.
- Do not enter plan mode or invoke other commands.

## Safety

- Never overwrite a target file without `--update`, never overwrite an edited one without `--update --force`, never overwrite `CLAUDE.md` content. The only deletions are `--update`'s: pipeline files the manifest recorded, that the source no longer ships and nobody edited.
- Copy only the pipeline directories named above and, when the target has none, `.claude/settings.json`; never edit a target's existing `settings.json` (report the snippet instead); never copy secrets, `.env` files or `settings.local.json`.
