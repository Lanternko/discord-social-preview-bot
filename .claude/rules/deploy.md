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
exit
```

**Always provide these steps after a merge** — the remote host tracks GitHub, not the local working tree.

## Secrets

`.env` lives on the deploy host, not in git. To rotate keys: scp a fresh `.env` from a trusted machine, or edit with `nano` on the host.

## Future hardening (not yet done)

- systemd service for auto-restart on crash/reboot
- log rotation for `bot.log`
