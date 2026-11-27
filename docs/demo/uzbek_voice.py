"""Render one local demo reply with the Cyrillic Uzbek MMS voice."""
import io
import json
from pathlib import Path
import re
import sys
import wave

import numpy as np
import onnxruntime as ort

cache = Path(__file__).resolve().parents[2] / "tmp/demo-repair/uz-voice"
vocab = json.loads((cache / "vocab.json").read_text())
letters = str.maketrans(dict(zip("abdvfgzijklmnopqrstuхxyh", "абдвфгзижклмнопқрстуххйҳ")))
digits = "ноль бир икки уч тўрт беш олти етти саккиз тўққиз".split()
tens = "ноль ўн йигирма ўттиз қирқ эллик олтмиш етмиш саксон тўқсон".split()


def number(n):
    if n < 10:
        return digits[n]
    for size, label in [(1000000, "миллион"), (1000, "минг"), (100, "юз")]:
        if n >= size:
            prefix = "" if size == 100 and n // size == 1 else number(n // size) + " "
            return prefix + label + (" " + number(n % size) if n % size else "")
    return tens[n // 10] + (" " + digits[n % 10] if n % 10 else "")


def normalize(text):
    text = text.lower().replace("willow", "виллоу").replace("uzi", "узи")
    text = re.sub(r"(?<=\d):00\b", "", text)
    text = re.sub(r"\d+", lambda m: number(int(m[0])) if len(m[0]) <= 9 else " ".join(digits[int(i)] for i in m[0]), text)
    text = re.sub("[’‘ʻʼ`]", "'", text)
    for latin, cyr in [("o'", "ў"), ("g'", "ғ"), ("sh", "ш"), ("ch", "ч"), ("yo", "ё"), ("yu", "ю"), ("ya", "я"), ("ye", "е"), ("'", "ъ")]:
        text = text.replace(latin, cyr)
    text = re.sub(r"\be", "э", text).replace("e", "е")
    return text.translate(letters)


opts = ort.SessionOptions()
opts.intra_op_num_threads = 2
model = ort.InferenceSession(str(cache / "model.onnx"), opts, providers=["CPUExecutionProvider"])
parts = []
for phrase in re.split(r"[.!?;:\n]+", normalize(sys.stdin.read())):
    tokens = [vocab[c] for c in phrase.strip() if c in vocab]
    if not tokens:
        continue
    ids = np.zeros((1, 2 * len(tokens) + 1), dtype=np.int64)
    ids[0, 1::2] = tokens
    feeds = {"input_ids": ids, "attention_mask": np.ones_like(ids)}
    audio = model.run(None, {i.name: feeds[i.name] for i in model.get_inputs()})[0].flatten()
    parts.extend([audio, np.zeros(3200)])
if not parts:
    sys.exit(1)
samples = (np.clip(np.concatenate(parts), -1, 1) * 32767).astype("<i2")
out = io.BytesIO()
with wave.open(out, "wb") as wav:
    wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
    wav.writeframes(samples.tobytes())
sys.stdout.buffer.write(out.getvalue())
