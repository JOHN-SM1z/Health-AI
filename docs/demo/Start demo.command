#!/bin/bash
set -eu
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export OLLAMA_HOST=127.0.0.1:11434
model=${DEMO_MODEL:-qwen3:1.7b}
if ! command -v ollama >/dev/null || ! command -v node >/dev/null; then
  echo "Demo uchun Ollama va Node.js kerak."; exit 1
fi
voice_cache=../../tmp/demo-repair/uz-voice
voice_env=../../tmp/demo-repair/tts
if ! "$voice_env/bin/python" -c 'import onnxruntime, numpy' 2>/dev/null; then
  python3 -m venv "$voice_env"
  "$voice_env/bin/python" -m pip install onnxruntime numpy
fi
mkdir -p "$voice_cache"
base=https://huggingface.co/davron112/mms-tts-uzb-cyrl-onnx/resolve/6c407c05fa87c2e2783acf684227cec4966c63fd
for file in vocab.json onnx/model.onnx; do
  dest="$voice_cache/${file##*/}"
  if [[ ! -s "$dest" ]]; then
    curl -fLsS --retry 2 "$base/$file" -o "$dest.part" && mv "$dest.part" "$dest"
  fi
done
if ! curl -fsS --max-time 2 "http://$OLLAMA_HOST/api/version" >/dev/null 2>&1; then
  ollama serve &
  for attempt in {1..30}; do
    if curl -fsS --max-time 2 "http://$OLLAMA_HOST/api/version" >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi
if ! ollama show "$model" >/dev/null 2>&1; then ollama pull "$model"; fi
url=http://127.0.0.1:8765
if curl -fsS --max-time 2 "$url" 2>/dev/null | grep -q 'Willow klinikasi'; then
  open "$url"
else
  node serve.mjs &
  demo_pid=$!
  trap 'kill "$demo_pid" 2>/dev/null || true' EXIT
  for attempt in {1..20}; do
    if curl -fsS --max-time 2 "$url" 2>/dev/null | grep -q 'Willow klinikasi'; then open "$url"; break; fi
    sleep 1
  done
  wait "$demo_pid"
fi
