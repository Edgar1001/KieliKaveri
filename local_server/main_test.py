import unittest
import json
import tempfile
import wave
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from local_server import main
from local_server.tutor import TutorResponse


class RealtimeSessionTest(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_offer_uses_server_key_and_automatic_turns(self) -> None:
        response = Mock(text="v=0\r\nanswer")
        post = AsyncMock(return_value=response)
        client = AsyncMock()
        client.__aenter__.return_value.post = post
        with (
            patch.object(main, "OPENAI_API_KEY", "private-test-key"),
            patch.object(main, "APP_API_KEY", "app-test-key"),
            patch.object(main.httpx, "AsyncClient", return_value=client),
            TestClient(main.app) as api,
        ):
            unauthorized = api.post("/api/realtime/session", json={"sdp": "v=0"})
            result = api.post("/api/realtime/session", headers={"X-App-Key": "app-test-key"}, json={
                "sdp": "v=0\r\noffer", "level": "B1", "languageMode": "Kirjakieli",
            })
        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(result.json(), {"sdp": "v=0\r\nanswer"})
        self.assertNotIn("private-test-key", result.text)
        config = json.loads(post.await_args.kwargs["files"]["session"][1])
        self.assertIn("CEFR B1", config["instructions"])
        self.assertIn("standard written Finnish", config["instructions"])
        self.assertEqual(config["audio"]["input"]["turn_detection"]["type"], "semantic_vad")
        response.raise_for_status.assert_called_once()

    async def test_rejects_missing_key_and_invalid_offer(self) -> None:
        with patch.object(main, "OPENAI_API_KEY", ""):
            with self.assertRaises(HTTPException):
                await main.realtime_session(main.RealtimeRequest(sdp="v=0"))
        with patch.object(main, "OPENAI_API_KEY", "test-key"):
            with self.assertRaises(HTTPException) as raised:
                await main.realtime_session(main.RealtimeRequest(sdp="invalid"))
        self.assertEqual(raised.exception.status_code, 400)


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


class TextConversationTest(unittest.IsolatedAsyncioTestCase):
    async def test_multipart_text_request_is_authenticated(self) -> None:
        expected = TutorResponse(
            correctedText="Moi!", explanation="A natural greeting.",
            reply="Mitä kuuluu?", translation="How are you?",
        )
        with (
            patch.object(main, "APP_API_KEY", "test-app-key"),
            patch.object(main, "generate_tutor_response", AsyncMock(return_value=expected)) as generate,
            TestClient(main.app) as client,
        ):
            unauthorized = client.post("/api/conversation", data={"text": "Moi!"})
            response = client.post(
                "/api/conversation",
                headers={"X-App-Key": "test-app-key"},
                files={"text": (None, "Moi!")},
            )
        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"transcript": "Moi!", **expected.model_dump()})
        generate.assert_awaited_once()

    async def test_text_reuses_tutor_without_transcription(self) -> None:
        expected = TutorResponse(
            correctedText="Moi!",
            explanation="A natural greeting.",
            reply="Mitä kuuluu?",
            translation="How are you?",
        )
        with (
            patch.object(main, "generate_tutor_response", AsyncMock(return_value=expected)) as generate,
            patch.object(main, "transcribe_audio", AsyncMock()) as transcribe,
            patch.object(main, "add_usage", AsyncMock()) as add_usage,
        ):
            result = await main.conversation(
                audio=None, text="  Moi!  ", topic="Arki", level="B2",
                languageMode="Puhekieli", history='[{"transcript":"Hei","reply":"Moi"}]',
                audioDurationMs=0,
            )
        self.assertEqual(result, {"transcript": "Moi!", **expected.model_dump()})
        self.assertEqual(generate.await_args.args[0], "Moi!")
        self.assertEqual(len(generate.await_args.args[2]), 1)
        self.assertEqual(generate.await_args.args[3:], ("B2", "Puhekieli"))
        transcribe.assert_not_awaited()
        add_usage.assert_not_awaited()

    async def test_rejects_empty_or_oversized_text(self) -> None:
        for text in ("  ", "x" * 4001):
            with self.subTest(text_length=len(text)):
                with self.assertRaises(HTTPException) as raised:
                    await main.conversation(
                        audio=None, text=text, topic="Arki", level="B2",
                        languageMode="Puhekieli", history="[]", audioDurationMs=0,
                    )
                self.assertEqual(raised.exception.status_code, 400)


class TranscriptionTest(unittest.IsolatedAsyncioTestCase):
    async def test_automatic_transcription_omits_previous_question_without_changing_puhe(self) -> None:
        previous_question = "What did you eat yesterday?"
        history = json.dumps([{"transcript": "Hello", "reply": previous_question}])
        expected = TutorResponse(
            correctedText="Moi!", explanation="A natural greeting.",
            reply="Mitä kuuluu?", translation="How are you?",
        )
        with (
            patch.object(main, "APP_API_KEY", "test-app-key"),
            patch.object(main, "transcribe_audio", AsyncMock(return_value="Moi!")) as transcribe,
            patch.object(main, "generate_tutor_response", AsyncMock(return_value=expected)) as generate,
            patch.object(main, "add_usage", AsyncMock()),
            TestClient(main.app) as client,
        ):
            for automatic in (False, True):
                with self.subTest(automatic=automatic):
                    data = {"history": history, "audioDurationMs": "30000"}
                    if automatic:
                        data["automatic"] = "true"
                    response = client.post(
                        "/api/conversation", headers={"X-App-Key": "test-app-key"},
                        data=data, files={"audio": ("speech.m4a", b"test-audio", "audio/mp4")},
                    )
                    self.assertEqual(response.status_code, 200)
                    prompt = transcribe.await_args.args[1]
                    if automatic:
                        self.assertNotIn(previous_question, prompt)
                        self.assertIn("Transcribe only words spoken", prompt)
                    else:
                        self.assertIn(previous_question, prompt)
                    self.assertEqual(generate.await_args.args[0], "Moi!")
                    self.assertEqual(generate.await_args.args[2][-1].reply, previous_question)

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


class HealthTest(unittest.IsolatedAsyncioTestCase):
    async def test_reports_finnish_speech_when_model_files_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            voice = Path(directory) / "voice.onnx"
            voice.touch()
            voice.with_suffix(".onnx.json").touch()

            with patch.object(main, "PIPER_VOICE", voice):
                result = await main.health()

        self.assertTrue(result["finnishSpeechConfigured"])


class UsageTest(unittest.IsolatedAsyncioTestCase):
    def cost_page(self, spend: float) -> SimpleNamespace:
        cost = SimpleNamespace(
            object="organization.costs.result",
            amount=SimpleNamespace(value=spend, currency="usd"),
        )
        return SimpleNamespace(
            data=[SimpleNamespace(results=[cost])], has_more=False, next_page=None,
        )

    async def test_missing_admin_key_labels_app_estimate(self) -> None:
        with (
            patch.object(main, "OPENAI_ADMIN_API_KEY", ""),
            patch.object(main, "estimated_spend_usd", 4.5),
            patch.object(main, "OPENAI_BUDGET_USD", 5.0),
            patch.object(main, "USAGE_FILE", None),
        ):
            result = await main.usage()
        self.assertEqual(result["estimatedSpendUsd"], 4.5)
        self.assertEqual(result["percentage"], 90.0)
        self.assertEqual(result["scope"], "since backend start")
        self.assertNotIn("remainingCreditUsd", result)

    async def test_organization_monthly_costs_are_not_credit(self) -> None:
        costs = AsyncMock(return_value=self.cost_page(1.25))
        client = SimpleNamespace(admin=SimpleNamespace(
            organization=SimpleNamespace(usage=SimpleNamespace(costs=costs)),
        ))
        with (
            patch.object(main, "OPENAI_ADMIN_API_KEY", "admin-key"),
            patch.object(main, "OPENAI_USAGE_PROJECT_ID", "ignored-project"),
            patch.object(main, "AsyncOpenAI", return_value=client),
        ):
            result = await main.usage()
        self.assertEqual(result["estimatedSpendUsd"], 1.25)
        self.assertEqual(result["scope"], "OpenAI Platform, current month")
        self.assertNotIn("remainingCreditUsd", result)
        costs.assert_awaited_once()
        self.assertNotIn("project_ids", costs.await_args.kwargs)

    async def test_monthly_spending_fetches_all_pages(self) -> None:
        last_page = self.cost_page(0.75)
        first_page = self.cost_page(1.25)
        first_page.has_more = True
        first_page.next_page = "next-cost-page"
        costs = AsyncMock(side_effect=[first_page, last_page])
        client = SimpleNamespace(admin=SimpleNamespace(
            organization=SimpleNamespace(usage=SimpleNamespace(costs=costs)),
        ))
        now = datetime(2026, 11, 1, tzinfo=timezone.utc)
        with (
            patch.object(main, "OPENAI_ADMIN_API_KEY", "admin-key"),
            patch.object(main, "AsyncOpenAI", return_value=client),
            patch.object(main, "datetime") as clock,
        ):
            clock.now.return_value = now
            result = await main.usage()
        self.assertEqual(result["estimatedSpendUsd"], 2.0)
        self.assertEqual(costs.await_args.kwargs["start_time"], int(
            datetime(2026, 11, 1, tzinfo=timezone.utc).timestamp(),
        ))
        self.assertEqual(costs.await_count, 2)
        self.assertNotIn("page", costs.await_args_list[0].kwargs)
        self.assertEqual(costs.await_args_list[1].kwargs["page"], "next-cost-page")

    async def test_billing_failure_does_not_substitute_app_spending(self) -> None:
        costs = AsyncMock(side_effect=main.OpenAIError("Billing unavailable"))
        client = SimpleNamespace(admin=SimpleNamespace(
            organization=SimpleNamespace(usage=SimpleNamespace(costs=costs)),
        ))
        with (
            patch.object(main, "OPENAI_ADMIN_API_KEY", "admin-key"),
            patch.object(main, "AsyncOpenAI", return_value=client),
        ):
            with self.assertRaises(HTTPException) as raised:
                await main.usage()
        self.assertEqual(raised.exception.status_code, 503)

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
    async def test_generates_finnish_neural_speech_with_cached_model(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            voice = Path(directory) / "voice.onnx"
            voice.touch()

            def synthesize(_text: str, wav_file: wave.Wave_write) -> None:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)
                wav_file.setframerate(22_050)
                wav_file.writeframes(b"\x00\x00")

            loaded_voice = SimpleNamespace(synthesize_wav=Mock(side_effect=synthesize))

            with (
                patch.object(main, "PIPER_VOICE", voice),
                patch.object(main, "piper_voice", None),
                patch.object(main.PiperVoice, "load", return_value=loaded_voice) as load,
            ):
                first_response = await main.speech(main.SpeechRequest(text="Mitä kuuluu?"))
                second_response = await main.speech(main.SpeechRequest(text="Hyvää kuuluu."))

            self.assertEqual(first_response.media_type, "audio/wav")
            self.assertEqual(second_response.media_type, "audio/wav")
            load.assert_called_once_with(voice)
            self.assertEqual(loaded_voice.synthesize_wav.call_count, 2)
            first_response.background.func(
                *first_response.background.args,
                **first_response.background.kwargs,
            )
            second_response.background.func(
                *second_response.background.args,
                **second_response.background.kwargs,
            )


if __name__ == "__main__":
    unittest.main()