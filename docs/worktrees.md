# Parallel work: git worktrees

## Why

A working tree's HEAD is a property of the **folder**, not of your conversation. Every process pointed at `apps/discord-social-preview-bot/` — other Claude sessions, your terminals, and the running bot, since `bot-watchdog.sh` relaunches `node src/index.js` from exactly that path — shares one branch. A `git checkout` there silently changes what all of them see, and what is live in production.

So: the main checkout stays on the prod branch. Every concurrent feature gets its own worktree, a sibling `apps/dspb-<feature>/`.

## Setup

```bash
cd ~/side_projects/apps/discord-social-preview-bot
git worktree add ../dspb-<feature> -b feat/<feature>          # new branch
git worktree add ../dspb-<feature> <existing-branch>          # or an existing one
ln -sf "$(pwd)/.env" ../dspb-<feature>/.env                   # .env + node_modules are
ln -sf "$(pwd)/node_modules" ../dspb-<feature>/node_modules   #   gitignored — link per worktree
```

Work, commit, and run the bot from that worktree. The harness may reset cwd back to the main dir between commands — address the worktree by absolute path or `git -C <path>`.

```bash
git worktree list                    # who is on what
git worktree remove ../dspb-<feature>   # when the branch is merged
```

Naming: `dspb-<feature>`, matching the branch (`feat/bilibili-video` → `dspb-bilibili`).

## Trap 1 — `npm test` fabricates a `data/`

The JSON stores resolve their paths **relative to cwd**, so a test run inside a worktree leaves behind a real `data/` directory holding fixtures (`sk-mykey` and friends). It looks exactly like the live one. Any script you later point at "real guild data" from that worktree reads the fixtures instead, and any write lands in the fake copy.

Before touching live data from a worktree:

```bash
rm -rf data && ln -s "$(pwd)/../discord-social-preview-bot/data" data
```

## Trap 2 — `git add -A` can commit the symlinks, and that deletes `data/`

A trailing-slash gitignore pattern (`data/`) does **not** match a symlink named `data`. So `git add -A` in a worktree happily stages the `.env` / `node_modules` / `data` links. Checking that branch out in the main tree then replaces the real directory with a link pointing at itself — **deleting its contents**. This happened on 2026-07-05; `data/` was recovered only because the running bot still had it in memory.

`.gitignore` now uses slash-less patterns, which blocks the staging. Older branches predate the fix, so before any checkout in the main tree:

```bash
git ls-tree <branch> -- data node_modules .env    # must print nothing
```

And always read `git status` before `git add -A` in a worktree.

## Shadow-deploying from a worktree

Running an unmerged branch against the live bot token is a worktree job, not a checkout. Steps and the two-bots-one-token warning: [deploy.md](deploy.md#shadow-deploy-a-branch-test-before-merge).
