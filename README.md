# Kielikaveri Android

This repository packages the Finnish tutor as an Android APK backed by a CPU-friendly Railway FastAPI service. The original `LanguageTutor` browser repository is separate and unchanged.

## Architecture

```text
Android APK
  -> Railway HTTPS API
     -> OpenAI gpt-transcribe (Finnish speech-to-text)
     -> OpenAI GPT-4.1 (correction, conversation, translation)
  -> Android Finnish text-to-speech
```

The app starts at B2 and Puhekieli and includes A2-C2 levels, Puhekieli/Kirjakieli, corrections, English explanations and translations, conversation history, replay, restart, and an estimated API budget meter.

## 1. Deploy the backend to Railway

Push this repository to a new GitHub repository. In Railway, create a new project, choose **Deploy from GitHub repo**, and select it. Railway automatically detects the root `Dockerfile`.

Add these variables to the Railway service (copy names from `railway.env.example`):

```dotenv
OPENAI_API_KEY=your-private-openai-key
OPENAI_MODEL=gpt-4.1
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
APP_API_KEY=a-long-random-value
OPENAI_BUDGET_USD=5
OPENAI_INPUT_COST_PER_MILLION=2
OPENAI_OUTPUT_COST_PER_MILLION=8
MAX_AUDIO_BYTES=15728640
USAGE_FILE=/data/usage.json
```

Generate `APP_API_KEY` locally with:

```bash
openssl rand -hex 32
```

Keep `OPENAI_API_KEY` only in Railway. `APP_API_KEY` is a basic personal-app gate, not a secret once embedded in an APK; do not rely on it for a public multi-user product.

In the Railway service:

1. Set **Healthcheck Path** to `/api/health`.
2. Under **Networking -> Public Networking**, click **Generate Domain**.
3. Keep one replica for the in-process request lock and usage estimate.
4. Optional: attach a small volume mounted at `/data` so `USAGE_FILE` survives restarts.
5. Deploy and verify `https://YOUR-DOMAIN/api/health` returns `status: ok`.

The old Railway `railway.json` config format is deprecated in 2026, so these settings intentionally live in the Railway dashboard while the Dockerfile remains in source control.

## 2. Configure the APK

Create the local Expo environment file:

```bash
cp .env.example .env
```

Set the generated Railway HTTPS domain and the same `APP_API_KEY` value:

```dotenv
EXPO_PUBLIC_API_URL=https://YOUR-DOMAIN.up.railway.app
EXPO_PUBLIC_APP_API_KEY=your-app-api-key
```

These `EXPO_PUBLIC_` values are compiled into the APK. Never put the OpenAI key in this file.

Install and check the app:

```bash
npm install
npm run typecheck
npm test
```

## 3. Build an installable APK

Sign in and configure EAS if this Expo project has not been linked yet:

```bash
npx eas-cli@latest login
npx eas-cli@latest build:configure
```

Create the two public EAS build variables for the `preview` environment, or enter them in the Expo project dashboard:

```bash
npx eas-cli@latest env:create --environment preview --name EXPO_PUBLIC_API_URL --value https://YOUR-DOMAIN.up.railway.app --visibility plaintext
npx eas-cli@latest env:create --environment preview --name EXPO_PUBLIC_APP_API_KEY --value YOUR_APP_API_KEY --visibility sensitive
```

Build the preview APK:

```bash
npx eas-cli@latest build --platform android --profile preview
```

EAS returns a download URL. Open it on the Android phone, download the APK, and allow installation from that browser when Android prompts.

## Security and cost

- Set hard spending limits in OpenAI; the in-app meter is only an estimate.
- The current meter covers tutor-model token usage and can persist on `/data`; OpenAI billing remains authoritative.
- Railway hosting and OpenAI API usage are billed separately.
- For personal use, the app key plus Railway/OpenAI limits is reasonable. Before public distribution, add user authentication, database-backed quotas, abuse monitoring, and per-user rate limits.
- Recordings are temporary files and are deleted after each request, but their audio is sent to OpenAI for transcription.

## Local backend checks

```bash
npm run setup:backend
npm test
npm run typecheck
```

To test the Railway-style backend locally, provide the variables from `railway.env.example` in your shell and run:

```bash
npm run api
```
