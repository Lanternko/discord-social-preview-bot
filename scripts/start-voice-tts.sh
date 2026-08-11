#!/usr/bin/env bash
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
arale_server_default=$(CDPATH= cd -- "$project_root/../arale-persona-bot" 2>/dev/null && pwd)/server/tts_server_irodori.py

tts_server_script=${XIBAO_TTS_SERVER_SCRIPT:-$arale_server_default}
voice_embed=${XIBAO_VOICE_EMBED:-$project_root/data/voice/xibao/irodori/mood-shy/speaker_inversion/checkpoint_final.speaker.safetensors}

if [ ! -f "$tts_server_script" ]; then
  echo "找不到 Arale Irodori TTS server：$tts_server_script" >&2
  echo "請用 XIBAO_TTS_SERVER_SCRIPT 指向 tts_server_irodori.py。" >&2
  exit 1
fi
if [ ! -f "$voice_embed" ]; then
  echo "找不到西寶 speaker embedding：$voice_embed" >&2
  echo "請用 XIBAO_VOICE_EMBED 指向 checkpoint_final.speaker.safetensors。" >&2
  exit 1
fi

export TTS_PORT=${TTS_PORT:-8056}
export TTS_IRODORI_DEFAULT_EMBED=$voice_embed
# Isolate mood lookup from Arale's own data directory. The shared server tries
# mood-specific names before its default; without this, mood=shy can silently
# select Arale's si_shy_gold instead of Xibao's checkpoint.
export TTS_IRODORI_EMBED_DIR=$(dirname -- "$voice_embed")
export TTS_TEMPO_SLOW=${TTS_TEMPO_SLOW:-1.0}

irodori_python=${XIBAO_IRODORI_PYTHON:-$HOME/side_projects/reference-repos/Irodori-TTS/.venv/bin/python}
exec "$irodori_python" "$tts_server_script"
