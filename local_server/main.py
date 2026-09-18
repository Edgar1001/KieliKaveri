import asyncio
import json
import logging
import os
import shutil
import tempfile
import threading
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from openai import APIError, AsyncOpenAI, OpenAIError
from piper import PiperVoice
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from starlette.background import BackgroundTask

from local_server.tutor import (
    HistoryTurn,
    LanguageMode,
    Level,
    Topic,
    TutorResponse,
    build_transcription_prompt,
    build_tutor_prompt,
)

logging.basicConfig(level=logging.INFO)
LOGGER = logging.getLogger("language-tutor")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_ADMIN_API_KEY = os.getenv("OPENAI_ADMIN_API_KEY", "")
OPENAI_USAGE_PROJECT_ID = os.getenv("OPENAI_USAGE_PROJECT_ID", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1")
OPENAI_TRANSCRIPTION_MODEL = os.getenv("OPENAI_TRANSCRIPTION_MODEL", "gpt-transcribe")
APP_API_KEY = os.getenv("APP_API_KEY", "")
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_BYTES", str(15 * 1024 * 1024)))
OPENAI_BUDGET_USD = float(os.getenv("OPENAI_BUDGET_USD", "5"))
OPENAI_INPUT_COST_PER_MILLION = float(os.getenv("OPENAI_INPUT_COST_PER_MILLION", "2"))
OPENAI_OUTPUT_COST_PER_MILLION = float(os.getenv("OPENAI_OUTPUT_COST_PER_MILLION", "8"))
OPENAI_TRANSCRIPTION_COST_PER_MINUTE = float(
    os.getenv("OPENAI_TRANSCRIPTION_COST_PER_MINUTE", "0.0045")
)
USAGE_FILE = Path(os.environ["USAGE_FILE"]) if os.getenv("USAGE_FILE") else None
PIPER_VOICE = Path(
    os.getenv(
        "PIPER_VOICE",
        str(Path(__file__).parent / "voices" / "fi_FI-harri-medium.onnx"),
    )
)
HISTORY_ADAPTER = TypeAdapter(list[HistoryTurn])
TOPIC_ADAPTER = TypeAdapter(Topic)
LEVEL_ADAPTER = TypeAdapter(Level)
LANGUAGE_MODE_ADAPTER = TypeAdapter(LanguageMode)
INFERENCE_LOCK = asyncio.Lock()
usage_lock = asyncio.Lock()
PIPER_LOCK = threading.Lock()
piper_voice: PiperVoice | None = None


def load_usage() -> tuple[float, float, int]:
    if USAGE_FILE is None or not USAGE_FILE.is_file():
        return 0.0, 0.0, 0
    try:
        stored_usage = json.loads(USAGE_FILE.read_text())
        return (
            float(stored_usage.get("estimatedSpendUsd", 0.0)),
            float(stored_usage.get("transcriptionMinutes", 0.0)),
            int(stored_usage.get("completedTurns", 0)),
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
        LOGGER.exception("Could not load persisted usage estimate")
        return 0.0, 0.0, 0


def save_usage(spend: float, transcription_minutes: float, completed_turns: int) -> None:
    if USAGE_FILE is None:
        return
    USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = USAGE_FILE.with_suffix(".tmp")
    temporary_file.write_text(
        json.dumps(
            {
                "estimatedSpendUsd": spend,
                "transcriptionMinutes": transcription_minutes,
                "completedTurns": completed_turns,
            }
        )
    )
    temporary_file.replace(USAGE_FILE)


estimated_spend_usd, transcription_minutes, completed_turns = load_usage()


async def add_usage(cost: float, audio_minutes: float = 0.0, turn_completed: bool = False) -> None:
    async with usage_lock:
        global estimated_spend_usd, transcription_minutes, completed_turns
        estimated_spend_usd += cost
        transcription_minutes += audio_minutes
        completed_turns += int(turn_completed)
        save_usage(estimated_spend_usd, transcription_minutes, completed_turns)


def synthesize_speech(text: str, output_path: Path) -> None:
    global piper_voice

    with PIPER_LOCK:
        if piper_voice is None:
            piper_voice = PiperVoice.load(PIPER_VOICE)
        with wave.open(str(output_path), "wb") as wav_file:
            piper_voice.synthesize_wav(text, wav_file)

app = FastAPI(
    title="Kielikaveri API",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)


@app.exception_handler(HTTPException)
async def http_exception_handler(_request: Any, error: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"error": str(error.detail)})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Any, _error: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": "Invalid request data."})


async def require_app_key(x_app_key: str = Header(default="")) -> None:
    if not APP_API_KEY or x_app_key != APP_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid app credentials.")


async def transcribe_audio(audio_path: Path, initial_prompt: str) -> str:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured.")
    try:
        client = AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=90)
        with audio_path.open("rb") as audio_file:
            transcription = await client.audio.transcriptions.create(
                model=OPENAI_TRANSCRIPTION_MODEL,
                file=audio_file,
                prompt=initial_prompt,
                extra_body={"languages": ["fi"]},
            )
    except APIError as error:
        LOGGER.exception("OpenAI transcription request failed")
        raise HTTPException(status_code=503, detail="Speech transcription is unavailable.") from error
    return transcription.text.strip()


async def generate_tutor_response(
    transcript: str,
    topic: Topic,
    history: list[HistoryTurn],
    level: Level = "B2",
    language_mode: LanguageMode = "Puhekieli",
) -> TutorResponse:
    if not OPENAI_API_KEY:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY is not configured.")

    try:
        client = AsyncOpenAI(api_key=OPENAI_API_KEY, timeout=60)
        response = await client.responses.parse(
            model=OPENAI_MODEL,
            instructions=build_tutor_prompt(topic, history, level, language_mode),
            input=f"Finnish learner utterance: {transcript}\nWrite the explanation in English only.",
            text_format=TutorResponse,
            temperature=0.1,
            max_output_tokens=500,
        )
    except APIError as error:
        LOGGER.exception("OpenAI tutor request failed")
        raise HTTPException(status_code=503, detail="The OpenAI tutor is unavailable.") from error

    if response.output_parsed is None:
        raise HTTPException(status_code=502, detail="The OpenAI tutor returned invalid output.")
    usage = getattr(response, "usage", None)
    if usage is not None:
        request_cost = (
            (usage.input_tokens or 0) * OPENAI_INPUT_COST_PER_MILLION
            + (usage.output_tokens or 0) * OPENAI_OUTPUT_COST_PER_MILLION
        ) / 1_000_000
        await add_usage(request_cost, turn_completed=True)
    return response.output_parsed


@app.get("/api/health")
async def health() -> dict[str, Any]:
    configured = bool(OPENAI_API_KEY and APP_API_KEY)
    return {
        "status": "ok" if configured else "setup_required",
        "openaiConfigured": bool(OPENAI_API_KEY),
        "appCredentialsConfigured": bool(APP_API_KEY),
        "openaiModel": OPENAI_MODEL,
        "transcriptionModel": OPENAI_TRANSCRIPTION_MODEL,
        "finnishSpeechConfigured": Path(PIPER_EXECUTABLE).is_file() and PIPER_VOICE.is_file(),
    }


@app.get("/api/usage", dependencies=[Depends(require_app_key)])
async def usage() -> dict[str, float | int | str]:
    if OPENAI_ADMIN_API_KEY:
        month_start = datetime.now(timezone.utc).replace(
            day=1,
            hour=0,
            minute=0,
            second=0,
            microsecond=0,
        )
        query: dict[str, Any] = {
            "start_time": int(month_start.timestamp()),
            "bucket_width": "1d",
            "limit": 31,
        }
        if OPENAI_USAGE_PROJECT_ID:
            query["project_ids"] = [OPENAI_USAGE_PROJECT_ID]
        try:
            client = AsyncOpenAI(admin_api_key=OPENAI_ADMIN_API_KEY, timeout=15)
            costs = await client.admin.organization.usage.costs(**query)
            spend = sum(
                result.amount.value
                for bucket in costs.data
                for result in bucket.results
                if result.object == "organization.costs.result"
                and result.amount is not None
                and result.amount.value is not None
                and result.amount.currency == "usd"
            )
            percentage = min(100.0, spend / OPENAI_BUDGET_USD * 100) if OPENAI_BUDGET_USD else 0.0
            return {
                "estimatedSpendUsd": round(spend, 6),
                "budgetUsd": OPENAI_BUDGET_USD,
                "percentage": round(percentage, 2),
                "scope": "OpenAI Platform, current month",
                "transcriptionMinutes": 0.0,
                "completedTurns": 0,
            }
        except OpenAIError:
            LOGGER.warning("OpenAI platform costs unavailable; using local usage", exc_info=True)

    async with usage_lock:
        spend = estimated_spend_usd
        minutes = transcription_minutes
        turns = completed_turns
    percentage = min(100.0, spend / OPENAI_BUDGET_USD * 100) if OPENAI_BUDGET_USD else 0.0
    return {
        "estimatedSpendUsd": round(spend, 6),
        "budgetUsd": OPENAI_BUDGET_USD,
        "percentage": round(percentage, 2),
        "scope": "persistent estimate" if USAGE_FILE else "since backend start",
        "transcriptionMinutes": round(minutes, 2),
        "completedTurns": turns,
    }


@app.post(
    "/api/speech",
    response_class=FileResponse,
    dependencies=[Depends(require_app_key)],
)
async def speech(request: SpeechRequest) -> FileResponse:
    if not PIPER_VOICE.is_file():
        raise HTTPException(status_code=503, detail="Finnish neural speech is not installed.")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output_file:
        output_path = Path(output_file.name)
    try:
        await asyncio.to_thread(
            synthesize_speech,
            request.text,
            output_path,
        )
    except Exception as error:
        output_path.unlink(missing_ok=True)
        LOGGER.exception("Piper synthesis failed")
        raise HTTPException(status_code=503, detail="Finnish speech synthesis failed.") from error

    return FileResponse(
        output_path,
        media_type="audio/wav",
        filename="kielikaveri.wav",
        background=BackgroundTask(output_path.unlink, missing_ok=True),
    )


@app.post("/api/conversation", dependencies=[Depends(require_app_key)])
async def conversation(
    audio: UploadFile = File(...),
    topic: str = Form("Arki"),
    level: str = Form("B2"),
    languageMode: str = Form("Puhekieli"),
    history: str = Form("[]"),
    audioDurationMs: int = Form(0),
) -> dict[str, str]:
    try:
        parsed_topic = TOPIC_ADAPTER.validate_python(topic)
        parsed_level = LEVEL_ADAPTER.validate_python(level)
        parsed_language_mode = LANGUAGE_MODE_ADAPTER.validate_python(languageMode)
        parsed_history = HISTORY_ADAPTER.validate_json(history)
        if len(parsed_history) > 4:
            raise ValueError("Conversation history is too long.")
        if not 0 <= audioDurationMs <= 60_000:
            raise ValueError("Invalid recording duration.")
    except (ValidationError, ValueError) as error:
        raise HTTPException(status_code=400, detail="Invalid conversation data.") from error

    suffix = Path(audio.filename or "speech.m4a").suffix or ".m4a"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temporary_file:
        temporary_path = Path(temporary_file.name)
        shutil.copyfileobj(audio.file, temporary_file)

    if temporary_path.stat().st_size > MAX_AUDIO_BYTES:
        temporary_path.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="The recording is too large.")

    try:
        async with INFERENCE_LOCK:
            transcription_prompt = build_transcription_prompt(
                parsed_topic,
                parsed_history,
                parsed_language_mode,
            )
            transcript = await transcribe_audio(temporary_path, transcription_prompt)
            if not transcript:
                raise HTTPException(status_code=422, detail="No Finnish speech was detected. Please try again.")
            audio_minutes = audioDurationMs / 60_000
            await add_usage(audio_minutes * OPENAI_TRANSCRIPTION_COST_PER_MINUTE, audio_minutes)
            tutor_response = await generate_tutor_response(
                transcript,
                parsed_topic,
                parsed_history,
                parsed_level,
                parsed_language_mode,
            )
        return {"transcript": transcript, **tutor_response.model_dump()}
    finally:
        temporary_path.unlink(missing_ok=True)