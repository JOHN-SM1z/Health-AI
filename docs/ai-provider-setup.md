# AI provider setup

The app is provider-agnostic: any **OpenAI-compatible chat completions API** works
(OpenAI, Azure OpenAI, Groq, Together, local vLLM, …).

## Env vars

| Var | Example | Meaning |
| --- | --- | --- |
| `AI_BASE_URL` | `https://api.openai.com/v1` | Base URL; `/chat/completions` is appended |
| `AI_API_KEY` | `sk-…` | API key (Secret Manager in production) |
| `AI_MODEL` | `gpt-4o-mini` | Model name |
| `AI_TEMPERATURE` | `0.2` | 0–2, default 0.2 |
| `ENABLE_AI` | `true` | Master switch — without it the bot answers from the FAQ/knowledge base only |

## Transcription (voice notes)

| Var | Example | Meaning |
| --- | --- | --- |
| `TRANSCRIPTION_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible `/audio/transcriptions` |
| `TRANSCRIPTION_API_KEY` | `sk-…` | Key |
| `TRANSCRIPTION_MODEL` | `whisper-1` | Model |
| `ENABLE_TRANSCRIPTION` | `true` | Master switch |

## Grounding & safety (do not disable)

The chat system prompt is assembled from:

1. clinic catalog (services, doctors, working hours, FAQs),
2. patient identity + current booking state,
3. hard rules: not a doctor, no diagnosis/prescription, urgency → escalate.

Every assistant reply is post-filtered by `src/lib/safety/policy.ts`:

- **urgency keywords** (uz/ru/en) → escalate to a human + Telegram admin alert,
- **disallowed claims** (diagnosis, prescription, dismissal of doctors) → reply is rejected
  and a safe fallback is returned instead.

The knowledge base (FAQ) answers are used verbatim when the AI is disabled or fails —
the bot never hard-fails.

## Costs & limits

- Enable `ENABLE_AI` only after testing with a cheap model (e.g. `gpt-4o-mini`).
- All AI calls are logged with token counts when `LOG_LEVEL=debug`.
- `AI_TEMPERATURE=0.2` keeps answers deterministic for a booking assistant.