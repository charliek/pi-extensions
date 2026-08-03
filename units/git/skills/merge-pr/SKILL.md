---
name: merge-pr
description: >-
  Merge a PR after verifying CI checks have passed. Use for "merge this PR",
  "merge it", or after watch-pr reports green. Always confirms merge strategy;
  never merges unless this skill is invoked directly. Cleans up remote and
  local branches after merge.
---

# Merge PR

Merge a pull request after verifying CI checks have passed. Choose squash vs
merge-commit based on commit quality, then clean up branches.

## Non-negotiable mechanics

1. **Never merge unless this skill is invoked directly.** Gauntlet and other
   flows must leave PRs open by default; they do not call this skill unless the
   user (or an explicit auto-merge request in the brief) asked to merge.
2. **Always confirm the merge strategy**, including on single-commit PRs —
   `--merge` and `--squash` leave different history, so the choice is the user's.
3. **Merge only the commit you verified.** Capture `headRefOid` during discovery
   and pass it as `--match-head-commit`, so a push that lands after the CI check
   cannot ride in unreviewed.
4. **Block** on drafts, already-merged/closed PRs, failed required checks, and
   merge conflicts. Informational bot-review checks are not required.
5. **No subagent required.** Run as the parent. Do not fall through to an
   API-rate model for anything that needs a subagent — there should be none.
6. When suggesting a follow-up watch, prefer the `watch-pr` skill when present;
   otherwise tell the user to run `gh pr checks` themselves.

## Workflow

### 1. Identify the PR

- If the user named a PR number:
  `gh pr view <number> --json number,state,title,isDraft,headRefName,headRefOid,baseRefName,commits,url`
- Otherwise the same without a number (current branch).
- Record `headRefOid`; step 4 merges that exact commit.
- Stop if: no PR found; draft (must be marked ready); already merged or closed.

### 2. Verify CI

```bash
gh pr checks <number>
```

All required checks must pass. Ignore informational bot-review checks
(CodeRabbit and similar). If required checks failed, stop and show which. If
checks are still running, suggest `watch-pr` (when present) first.

When the base branch defines required checks, `gh pr checks <number> --required`
narrows the gate to exactly those. Do not use it unconditionally: with no
required checks configured it exits non-zero because it found nothing, which
reads as failure.

### 3. Determine merge strategy

1. List headlines:
   `gh pr view <number> --json commits --jq '.commits[] | .messageHeadline'`
2. Show them to the user.
3. Recommend:
   - **squash** when most commits look like fix-ups ("fix lint", "fix CI",
     "address review", "WIP", "debug", "cleanup", "nit", or short/generic
     messages iterating on earlier commits in the same PR)
   - **merge commit** when commits are meaningful, atomic, and distinct, or
     when the PR is a single commit
4. Ask the user, putting the recommended option first with "(Recommended)"
   and a brief reason on each option. Ask even for a single-commit PR — squash
   and merge produce different history on the base branch.

### 4. Merge

```bash
gh pr merge <number> --merge --delete-branch --match-head-commit <headRefOid>
# or
gh pr merge <number> --squash --delete-branch --match-head-commit <headRefOid>
```

If the merge is rejected because the head moved, re-run from step 1 rather than
dropping `--match-head-commit`.

### 5. Clean up local state

`--delete-branch` already removes the remote branch and usually the local one.
Only clean up what it left behind:

```bash
git checkout <baseRefName>
git pull
```

If `<headRefName>` still exists locally, try `git branch -d <headRefName>`. After
a squash merge this fails, because the branch's commits are not ancestors of the
base — that is expected, not an error to work around. Leave the branch in place
and tell the user; never use `git branch -D` without their explicit go-ahead.

### 6. Confirm

Report PR URL/title and which strategy was used.

## Error handling

- No PR → ask for a number.
- Checks still running → suggest `watch-pr` when present.
- Checks failed → show which; do not merge.
- Draft → tell the user to mark ready first.
- Merge conflicts → user must resolve before merging.
- Permission errors → user may lack merge access.
