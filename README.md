# Kielikaveri Android

This repository packages the Finnish tutor as an Android APK backed by a CPU-friendly Railway FastAPI service. The original `LanguageTutor` browser repository is separate and unchanged.

## Architecture

```text
Android APK
  -> Railway HTTPS API
     -> OpenAI gpt-transcribe (Finnish speech-to-text)
     -> OpenAI GPT-4.1 (correction, conversation, translation)
    -> Piper fi_FI-harri-medium (Finnish neural speech)
  -> Android Finnish text-to-speech fallback
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
OPENAI_TRANSCRIPTION_COST_PER_MINUTE=0.0045
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

## Local Gradle APK build

EAS is not required for a local APK. The machine needs JDK 17, Android SDK tools, and `adb`. Generate the native Android project and build it with the included Gradle wrapper:

```bash
set -a
. .env
set +a
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```

The APK is created at `android/app/build/outputs/apk/release/app-release.apk`. With a USB-debugging-enabled phone connected, install it with:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Export `.env` before running Gradle so Metro receives `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_API_KEY` during the release bundle step. Run `npx expo prebuild` after changing `.env`. The generated `android/` directory is ignored because it can be recreated from the Expo project. A local release build is suitable for personal installation; configure a proper release keystore before distributing through Google Play.

## Security and cost

- Set hard spending limits in OpenAI; the in-app meter is only an estimate.
- The meter covers transcription duration and actual tutor-model token usage. It can persist on `/data`; OpenAI billing remains authoritative.
- Railway serves the same Finnish Piper voice as the browser app. Android falls back to its best installed `fi-FI` voice if neural speech is unavailable.
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
