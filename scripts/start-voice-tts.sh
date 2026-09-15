#!/usr/bin/env bash
# 西寶語音走阿拉蕾那顆共用 Irodori（127.0.0.1:8055，ref_id=xibao）。
# 不再另起 8056。8055 已掛 xibao embed 就離開；否則去叫阿拉蕾 start script。
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
arale_start=$(CDPATH= cd -- "$project_root/../arale-persona-bot" 2>/dev/null && pwd)/server/start_tts_irodori.sh
pilotfish_embed=$HOME/side_projects/apps/dspb-pilotfish/data/voice/xibao/irodori/clean-41-sep/speaker_inversion/checkpoint_final.speaker.safetensors
local_embed=$project_root/data/voice/xibao/irodori/clean-41-sep/speaker_inversion/checkpoint_final.speaker.safetensors

if [ -n "${XIBAO_VOICE_EMBED:-}" ]; then
  voice_embed=$XIBAO_VOICE_EMBED
elif [ -f "$local_embed" ]; then
  voice_embed=$local_embed
else
  voice_embed=$pilotfish_embed
fi

if [ ! -f "$voice_embed" ]; then
  echo "找不到西寶 speaker embedding：$voice_embed" >&2
  echo "請用 XIBAO_VOICE_EMBED 指向 checkpoint_final.speaker.safetensors。" >&2
  exit 1
fi

shared_url=${TTS_SERVER_URL:-http://127.0.0.1:8055}
if health=$(curl -fsS --max-time 5 "$shared_url/health" 2>/dev/null); then
  if printf '%s' "$health" | grep -q '"xibao"'; then
    echo "[xibao-tts] shared $shared_url already has xibao embed"
    exit 0
  fi
  echo "[xibao-tts] $shared_url 在跑但沒有 xibao embed，重啟共用 server" >&2
fi

if [ ! -x "$arale_start" ] && [ ! -f "$arale_start" ]; then
  echo "找不到阿拉蕾 start_tts_irodori.sh：$arale_start" >&2
  exit 1
fi

export XIBAO_VOICE_EMBED=$voice_embed
export TTS_PORT=${TTS_PORT:-8055}
exec bash "$arale_start"
