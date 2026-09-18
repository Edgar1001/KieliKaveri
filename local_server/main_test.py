import unittest
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from local_server import main
from local_server.tutor import TutorResponse


class GenerateTutorResponseTest(unittest.IsolatedAsyncioTestCase):
    async def test_returns_structured_openai_response(self) -> None:
        expected = TutorResponse(
            correctedText="Minä haluan yhden kahvin.",
            explanation="Use the object form for one complete coffee.",
            reply="Totta kai. Haluatko kahviin maitoa?",
            translation="Of course. Would you like milk in your coffee?",
        )
        parse = AsyncMock(return_value=SimpleNamespace(output_parsed=expected))
        client = SimpleNamespace(responses=SimpleNamespace(parse=parse))

        with (
            patch.object(main, "OPENAI_API_KEY", "test-key"),
            patch.object(main, "AsyncOpenAI", return_value=client),
        ):
            result = await main.generate_tutor_response(
                "Minä haluan yksi kahvi.",
                "Kahvila",
                [],
                "B1",
                "Kirjakieli",
            )

        self.assertEqual(result, expected)
        self.assertEqual(parse.await_args.kwargs["model"], main.OPENAI_MODEL)
        self.assertIs(parse.await_args.kwargs["text_format"], TutorResponse)
        self.assertIn("CEFR B1", parse.await_args.kwargs["instructions"])
        self.assertIn("standard written Finnish", parse.await_args.kwargs["instructions"])

    async def test_rejects_missing_api_key(self) -> None:
        with patch.object(main, "OPENAI_API_KEY", ""):
            with self.assertRaisesRegex(HTTPException, "OPENAI_API_KEY"):
                await main.generate_tutor_response("Hei!", "Arki", [])


class TranscriptionTest(unittest.IsolatedAsyncioTestCase):
    async def test_transcribes_with_finnish_context(self) -> None:
        create = AsyncMock(return_value=SimpleNamespace(text="Moi, mitä kuuluu?"))
        client = SimpleNamespace(audio=SimpleNamespace(transcriptions=SimpleNamespace(create=create)))
        with tempfile.NamedTemporaryFile(suffix=".m4a") as audio_file:
            with (
                patch.object(main, "OPENAI_API_KEY", "test-key"),
                patch.object(main, "AsyncOpenAI", return_value=client),
            ):
                result = await main.transcribe_audio(Path(audio_file.name), "Keskustelu arjesta")

        self.assertEqual(result, "Moi, mitä kuuluu?")
        self.assertEqual(create.await_args.kwargs["model"], main.OPENAI_TRANSCRIPTION_MODEL)
        self.assertEqual(create.await_args.kwargs["extra_body"], {"languages": ["fi"]})


class UsageTest(unittest.IsolatedAsyncioTestCase):
    async def test_usage_returns_capped_percentage(self) -> None:
        with (
            patch.object(main, "OPENAI_ADMIN_API_KEY", ""),
            patch.object(main, "estimated_spend_usd", 4.5),
            patch.object(main, "OPENAI_BUDGET_USD", 5.0),
        ):
            result = await main.usage()

        self.assertEqual(result["estimatedSpendUsd"], 4.5)
        self.assertEqual(result["percentage"], 90.0)
        self.assertEqual(result["scope"], "since backend start")

    async def test_usage_returns_openai_platform_costs_with_admin_key(self) -> None:
        amount = SimpleNamespace(value=1.25, currency="usd")
        cost = SimpleNamespace(object="organization.costs.result", amount=amount)
        costs = AsyncMock(
            return_value=SimpleNamespace(data=[SimpleNamespace(results=[cost])])
        )
        client = SimpleNamespace(
            admin=SimpleNamespace(
                organization=SimpleNamespace(usage=SimpleNamespace(costs=costs))
            )
        )
        with (
            patch.object(main, "OPENAI_ADMIN_API_KEY", "admin-key"),
            patch.object(main, "OPENAI_BUDGET_USD", 5.0),
            patch.object(main, "AsyncOpenAI", return_value=client) as openai_client,
        ):
            result = await main.usage()

        self.assertEqual(result["estimatedSpendUsd"], 1.25)
        self.assertEqual(result["percentage"], 25.0)
        self.assertEqual(result["scope"], "OpenAI Platform, current month")
        openai_client.assert_called_once_with(admin_api_key="admin-key", timeout=15)

    async def test_adds_transcription_usage(self) -> None:
        with (
            patch.object(main, "estimated_spend_usd", 0.0),
            patch.object(main, "transcription_minutes", 0.0),
            patch.object(main, "completed_turns", 0),
            patch.object(main, "save_usage") as save_usage,
        ):
            await main.add_usage(0.00045, audio_minutes=0.1)

            self.assertEqual(main.estimated_spend_usd, 0.00045)
            self.assertEqual(main.transcription_minutes, 0.1)
            save_usage.assert_called_once_with(0.00045, 0.1, 0)


class SpeechTest(unittest.IsolatedAsyncioTestCase):
    async def test_generates_finnish_neural_speech(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "piper"
            voice = Path(directory) / "voice.onnx"
            executable.touch()
            voice.touch()

            def create_output(command: list[str], **_kwargs: object) -> None:
                Path(command[command.index("--output_file") + 1]).write_bytes(b"RIFFtest")

            with (
                patch.object(main, "PIPER_EXECUTABLE", str(executable)),
                patch.object(main, "PIPER_VOICE", voice),
                patch.object(main.subprocess, "run", side_effect=create_output) as run,
            ):
                response = await main.speech(main.SpeechRequest(text="Mitä kuuluu?"))

            self.assertEqual(response.media_type, "audio/wav")
            self.assertIn("--model", run.call_args.args[0])
            response.background.func(*response.background.args, **response.background.kwargs)


if __name__ == "__main__":
    unittest.main()