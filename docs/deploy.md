# Deploy & Run

## Running locally

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium
cp .env.example .env   # fill in DISCORD_TOKEN
npm start
```

macOS convenience scripts: `start-bot.command` / `stop-bot.command`.

## Production deployment

Bot runs 24/7 on **this machine** (the same host Claude Code runs on) via `nohup`. No SSH needed — just run commands directly. Path: `~/side_projects/apps/discord-social-preview-bot/`.

**Production is the main checkout's working tree, whatever branch it is on** — `scripts/bot-watchdog.sh` hardcodes `REPO=~/side_projects/apps/discord-social-preview-bot` and relaunches `node src/index.js` from there. Two consequences:

- **There is no separate deploy branch.** Whatever `git branch --show-current` prints in that folder is what's live (2026-08-29: `fix/recap-deepseek-empty`, not `main` and not a `deploy/*` branch). Check it before assuming.
- **Uncommitted edits in that working tree go live on the next restart.** Run `git status` before restarting; another session's half-finished work is not your deploy.

A cron watchdog runs every minute and restarts the bot if the process is gone, so `kill <pid>` alone is a valid restart — or run `scripts/bot-watchdog.sh` by hand to skip the wait. Do **not** `pkill -f 'node src/index.js'`: that pattern also matches Claude Code's own tool shells (use `pkill -xf` or the pid).

### Daily ops

```bash
# See recent log
tail -50 ~/side_projects/apps/discord-social-preview-bot/bot.log

# Health check
pgrep -f 'node src/index.js'
```

### Redeploy after merging

Merge the PR into **the branch the main checkout is already on** (see above) so the deploy never needs a `git checkout` in that shared folder.

⚠️ **Run `npm test` in the feature worktree, BEFORE merging — never in the main checkout.** The JSON stores resolve their path from the *module's own directory*, not from cwd: `src/ai/guild-key-store.js` uses `path.join(__dirname, "..", "..", "data", "guild-api-keys.json")`, and `src/ai/rate-limiter.js`, `src/ai/memory.js`, `src/familiarity.js`, `src/guild-profile-store.js`, `src/user-profile-store.js` all do the same. So the `data/` a test run writes to is the one next to the `src/` that was loaded. In a worktree that's the worktree's own throwaway `data/` (harmless, and the reason CLAUDE.md tells you to re-link it before touching live data). In the main checkout it is the **live** `data/` the running bot reads — `scripts/smoke-ai-circuit.js` would stamp the fixture guild key `sk-mykey` and fake rate-limit counters straight into production state. Testing on the branch is what CLAUDE.md already mandates anyway; by redeploy time it is already done.

```bash
cd ~/side_projects/apps/discord-social-preview-bot
git branch --show-current          # confirm this is the branch you merged into
git status --short                 # anything uncommitted goes live too — check whose it is
git merge --ff-only origin/<that-branch>
# NO npm test here — it would write test fixtures into the live data/ (see above)
kill "$(pgrep -xf 'node src/index.js')"   # watchdog relaunches within 60s
./scripts/bot-watchdog.sh                 # or restart immediately
tail -20 bot.log
```

### Verify restart success

After `nohup ... &`, check `bot.log` for these lines (in this order):

```
Logged in as 西寶#<discriminator>
目前已加入 <N> 個伺服器
[ai] chain=<provider1> → <provider2> → ... timeout=<N>ms
```

If slash commands changed in the deploy, also look for:

```
[commands] registered /<name>   # first time seeing a new command
[commands] updated /<name>      # existing command's description changed
```

No `[commands]` line appears when all registered commands already match — this is normal after a no-op restart.

**Red flags** — grep for these:

```bash
grep -i 'error\|unhandled\|ECONN\|ENOTFOUND' bot.log
grep 'chain exhausted' bot.log   # AI chain drained for every mention
```

### Shadow-deploy a branch (test before merge)

```bash
cd ~/side_projects/apps/discord-social-preview-bot
git fetch origin
git checkout <branch-name>
pkill -f 'src/index.js' && sleep 1
nohup node src/index.js > bot.log 2>&1 &
sleep 3 && tail -20 bot.log
```

To roll back:

```bash
git checkout main
pkill -f 'src/index.js' && sleep 1
nohup node src/index.js > bot.log 2>&1 &
```

## Secrets

`.env` lives on this machine, not in git. To rotate keys: edit with `nano` directly, or scp from a trusted machine.

## Auto-restart watchdog

A cron watchdog restarts the bot within ~1 min if its process dies (crash, ENOSPC, reboot). Script: [scripts/bot-watchdog.sh](../scripts/bot-watchdog.sh), installed as `* * * * *` in the user crontab. Restart events log to `/tmp/bot_watchdog.log`; bot stdout still appends to `bot.log`.

**Current status (2026-09-10): the watchdog is ACTIVE.** `crontab -l` shows a live, uncommented line with the correct post-`apps/` path:

```cron
* * * * * /home/kojiek/side_projects/apps/discord-social-preview-bot/scripts/bot-watchdog.sh
```

Verify any time with:

```bash
crontab -l | grep watchdog
```

Consequence: the bot relaunches on its own within ~1 min of dying, so `kill <pid>` is a restart, not a stop. (Earlier revisions of this file said the line was commented out and pointed at the old flat path — both are stale; do not act on that.)

- The watchdog matches the process with `pgrep -f '[n]ode src/index.js'` — the `[n]` bracket trick stops the pattern from matching the watchdog's own shell. (Plain `pkill -f 'src/index.js'` from an interactive shell self-matches and can kill the shell — prefer `pgrep -f 'node src/index.js'` → `kill <pid>` for manual ops.)
- **To stop the bot for maintenance, comment out the cron line first** (`crontab -e`, prefix with `#`) — otherwise the watchdog relaunches it within a minute. This is load-bearing now that the line is live: without it there is no way to keep the bot down. Uncomment it when maintenance is over.

## Future hardening (not yet done)

- systemd service for auto-restart on crash/reboot (cron watchdog above covers the common case)
- log rotation for `bot.log`
