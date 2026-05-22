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

## Production deployment (SSH host)

Bot runs 24/7 on a Linux lab machine via `nohup`. Path: `~/side_projects/discord-social-preview-bot/`.

### Daily ops

```bash
# See recent log
ssh <host> "tail -50 ~/side_projects/discord-social-preview-bot/bot.log"

# Health check
ssh <host> "ps aux | grep 'node.*index.js' | grep -v grep"
```

### Redeploy after merging to main

```bash
ssh <host>
cd ~/side_projects/discord-social-preview-bot
git pull
pkill -f 'src/index.js' && sleep 1
nohup node src/index.js > bot.log 2>&1 &
sleep 3 && tail -20 bot.log
exit
```

**Always provide these steps after a merge** — the remote host tracks GitHub, not the local working tree.

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

To dry-run a PR on the production host without merging to `main`:

```bash
ssh <host>
cd ~/side_projects/discord-social-preview-bot
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

`.env` lives on the deploy host, not in git. To rotate keys: scp a fresh `.env` from a trusted machine, or edit with `nano` on the host.

## Auto-restart watchdog

A cron watchdog restarts the bot within ~1 min if its process dies (crash, ENOSPC, reboot). Script: [scripts/bot-watchdog.sh](../../scripts/bot-watchdog.sh), installed as `* * * * *` in the user crontab. Restart events log to `/tmp/bot_watchdog.log`; bot stdout still appends to `bot.log`.

- The watchdog matches the process with `pgrep -f '[n]ode src/index.js'` — the `[n]` bracket trick stops the pattern from matching the watchdog's own shell. (Plain `pkill -f 'src/index.js'` from an interactive shell self-matches and can kill the shell — prefer `pgrep -f 'node src/index.js'` → `kill <pid>` for manual ops.)
- **To stop the bot for maintenance, comment out the cron line first** — otherwise the watchdog relaunches it within a minute.

## Future hardening (not yet done)

- systemd service for auto-restart on crash/reboot (cron watchdog above covers the common case)
- log rotation for `bot.log`
