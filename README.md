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

The app starts at B2 and Puhekieli and includes A2-C2 levels, Puhekieli/Kirjakieli, corrections, English explanations and translations, conversation history, replay, restart, and an estimated API budget meter. The Puhe/Viestit/Auto puhe/RT puhe mode switch selects recorded voice, written conversation, hands-free recorded voice, or realtime voice. Each mode has independent history; switching modes preserves that mode's conversation and the unsent written draft. Restart clears only the selected conversation. Written mode uses a text composer without recording, playback, or automatic speech, and keeps the latest reply in view when the keyboard opens. Puhe, Viestit, and Auto puhe use `/api/conversation`.

Auto puhe uses the same microphone recording settings, transcription model, tutor model, speech playback, correction cards, and API pricing as Puhe, not realtime audio pricing. Tap start once: local microphone metering detects speech relative to the measured background level. The Vastausaika slider selects the recording window from 10 to 60 seconds in one-second steps (default 60); detected speech is sent only when that window ends, not during short pauses. Recording resumes after the tutor finishes speaking. Slider changes apply to the next recording. Missing microphone metering is reported only at the selected deadline. The microphone is off during processing and replies, so spoken interruptions are not supported. Recordings without detected speech are discarded; idle recording windows restart automatically without ending the session or making an API request. If transcription returns no Finnish speech, Auto puhe resumes listening without an error popup; other errors still stop the session and are reported. Recorded pauses still count toward transcription duration, so longer windows can increase costs despite using the same model rates. This mode requires Android microphone metering, stops in the background, and may misidentify speech in windy or noisy conditions. Tap stop to discard the current recording and cancel pending client work; server work already started may still be billed.

RT puhe uses OpenAI Realtime over WebRTC. Start a session once, then speak naturally: speech detection handles turns and interruptions without pressing a recording button for each message. This mode shows live transcripts and gives corrections aloud rather than generating the structured correction and translation cards used by Puhe/Viestit. It uses the selected level, language style, and recent realtime conversation history. Sessions stop when leaving the mode or putting the app in the background; Bluetooth-specific routing and locked-screen operation are not part of this mode. Deploy the updated Railway backend, including `/api/realtime/session`, before using RT puhe. The backend exchanges the connection offer with OpenAI using its private key; audio then streams directly over WebRTC.

## 1. Deploy the backend to Railway

Push this repository to a new GitHub repository. In Railway, create a new project, choose **Deploy from GitHub repo**, and select it. Railway automatically detects the root `Dockerfile`.

Add these variables to the Railway service (copy names from `railway.env.example`):

```dotenv
OPENAI_API_KEY=your-private-openai-key
OPENAI_ADMIN_API_KEY=your-openai-admin-key
OPENAI_USAGE_PROJECT_ID=
OPENAI_MODEL=gpt-4.1
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
OPENAI_REALTIME_MODEL=gpt-realtime-2.1
APP_API_KEY=a-long-random-value
OPENAI_BUDGET_USD=5
OPENAI_INPUT_COST_PER_MILLION=2
OPENAI_OUTPUT_COST_PER_MILLION=8
OPENAI_TRANSCRIPTION_COST_PER_MINUTE=0.0045
MAX_AUDIO_BYTES=15728640
USAGE_FILE=/data/usage.json
```

`OPENAI_ADMIN_API_KEY` enables automatic spending totals for the current UTC month across the whole OpenAI organization, including all cost result pages. The app refreshes once a minute; OpenAI billing data can arrive late. `OPENAI_USAGE_PROJECT_ID` does not filter these totals. The bar compares spending with `OPENAI_BUDGET_USD`, a spending target, not a credit balance. Monthly spending resets each month. OpenAI's supported API does not expose the live prepaid balance or top-ups; the billing shortcut opens the OpenAI dashboard where the actual balance is available. No starting balance or manual top-up tracking is required.

Without an admin key, the app explicitly displays an app-only cost estimate instead of organization spending. That estimate covers Puhe/Viestit, not realtime sessions; organization billing includes realtime charges when OpenAI reports them. If organization billing requests fail, the last displayed value is marked stale rather than silently replaced with app-only costs.

Generate `APP_API_KEY` locally with:

```bash
openssl rand -hex 32
```

Keep `OPENAI_API_KEY` only in Railway. `APP_API_KEY` is a basic personal-app gate, not a secret once embedded in an APK; do not rely on it for a public multi-user product.

In the Railway service:

1. Set **Healthcheck Path** to `/api/health`.
2. Under **Networking -> Public Networking**, click **Generate Domain**.
3. Keep one replica for the in-process request lock and usage estimate.
4. Optional: attach a small volume mounted at `/data` so the app-only estimate in `USAGE_FILE` survives restarts and redeployments. Organization spending is fetched from OpenAI and does not require a volume.
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
npm run test:realtime
npm run test:auto-speech
```

Use Node.js 22 or newer for Expo SDK 57. RT puhe requires a native Android build because Expo Go does not include WebRTC. With Android SDK tools, JDK 17, and an emulator or USB-debugging-enabled phone available, `npm run android` builds and launches the native debug app with Metro. Puhe and Viestit remain available in Expo Go.

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

- Set spending limits and auto-recharge settings in OpenAI as appropriate; the in-app bar shows spending against a budget, not remaining prepaid credit.
- The app-only meter covers recorded transcription duration and actual tutor-model token usage, but excludes realtime sessions. It can persist on `/data`; OpenAI organization billing remains authoritative and includes realtime usage.
- Railway serves the same Finnish Piper voice as the browser app. Android falls back to its best installed `fi-FI` voice if neural speech is unavailable.
- Railway hosting and OpenAI API usage are billed separately.
- RT puhe uses the configured OpenAI realtime model and its audio pricing rather than Piper or Android text-to-speech. Stop the session when finished to release the microphone and connection.
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
