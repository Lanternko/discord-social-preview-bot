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

```bash
cd ~/side_projects/apps/discord-social-preview-bot
git branch --show-current          # confirm this is the branch you merged into
git status --short                 # anything uncommitted goes live too — check whose it is
git merge --ff-only origin/<that-branch>
npm test
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

Run it from a **worktree**, never by checking the branch out in the main checkout — that folder *is* prod, and its HEAD is shared by every process pointed at it. Worktree rules and traps: [worktrees.md](worktrees.md).

```bash
cd ~/side_projects/apps
git -C discord-social-preview-bot worktree add ../dspb-shadow <branch-name>
ln -sf ~/side_projects/apps/discord-social-preview-bot/.env dspb-shadow/.env
ln -sf ~/side_projects/apps/discord-social-preview-bot/node_modules dspb-shadow/node_modules
cd dspb-shadow && nohup node src/index.js > bot.log 2>&1 &
sleep 3 && tail -20 bot.log
```

⚠️ **Two processes on one token both answer every message.** The `.env` symlink above shares prod's token, so stop prod first — comment out the watchdog cron, then `kill "$(pgrep -xf 'node src/index.js')"` — or give the shadow its own test token instead of the symlink.

Tear down:

```bash
kill <shadow-pid>
git -C ~/side_projects/apps/discord-social-preview-bot worktree remove ../dspb-shadow
# re-enable the watchdog cron if you disabled it
```

## Secrets

`.env` lives on this machine, not in git. To rotate keys: edit with `nano` directly, or scp from a trusted machine.

## Auto-restart watchdog

A cron watchdog relaunches the bot within ~1 min whenever its process is gone — crash, ENOSPC, reboot, or a deliberate `kill`. Script: [scripts/bot-watchdog.sh](../scripts/bot-watchdog.sh), installed in the user crontab as:

```cron
* * * * * /home/kojiek/side_projects/apps/discord-social-preview-bot/scripts/bot-watchdog.sh
```

**Status: enabled and firing.** Verified 2026-08-29 — the line is in `crontab -l` and `/tmp/bot_watchdog.log` records a restart the same day. (This section previously claimed the cron was commented out; it was not.)

- `REPO` is hardcoded to the main checkout — that is *why* prod is whatever branch that folder is on (see [Production deployment](#production-deployment)).
- Restart events log to `/tmp/bot_watchdog.log`; bot stdout still appends to `bot.log`.
- The watchdog finds its target with `pgrep -f '[n]ode src/index.js'` — the `[n]` bracket trick stops the pattern from matching the watchdog's own shell. For manual ops use `pgrep -xf 'node src/index.js'` → `kill <pid>`; plain `pkill -f 'src/index.js'` also matches Claude Code's tool shells.
- **To stop the bot for maintenance, comment out the cron line first** — otherwise it is back within a minute.

## Future hardening (not yet done)

- systemd service for auto-restart on crash/reboot (cron watchdog above covers the common case)
- log rotation for `bot.log`
