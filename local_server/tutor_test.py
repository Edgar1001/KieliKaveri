import unittest

from pydantic import ValidationError

from local_server.tutor import (
    HistoryTurn,
    TutorResponse,
    build_transcription_prompt,
    build_tutor_prompt,
)


class TutorPromptTest(unittest.TestCase):
    def test_prompt_includes_topic_and_recent_context(self) -> None:
        prompt = build_tutor_prompt(
            "Kahvila",
            [HistoryTurn(transcript="Haluaisin kahvi.", reply="Haluatko maitoa kahviin?")],
            "B2",
            "Puhekieli",
        )

        self.assertIn("cafe small talk", prompt)
        self.assertIn("Haluaisin kahvi", prompt)
        self.assertIn("Haluatko maitoa", prompt)
        self.assertIn("Minä haluan yhden kahvin", prompt)
        self.assertIn("joined words", prompt)
        self.assertIn("Never name a grammar case unless", prompt)
        self.assertIn("CEFR B2", prompt)
        self.assertIn("natural neutral Finnish puhekieli", prompt)
        self.assertIn("silently verify person", prompt)

    def test_response_rejects_missing_fields(self) -> None:
        with self.assertRaises(ValidationError):
            TutorResponse.model_validate({"reply": "Hei!"})

    def test_response_schema_requires_english_explanation(self) -> None:
        schema = TutorResponse.model_json_schema()

        self.assertIn("English only", schema["properties"]["explanation"]["description"])

    def test_transcription_prompt_includes_topic_and_latest_question(self) -> None:
        prompt = build_transcription_prompt(
            "Arki",
            [HistoryTurn(transcript="Hyvää kuuluu.", reply="Mitä teit tänään?")],
            "Puhekieli",
        )

        self.assertIn("arjesta", prompt)
        self.assertIn("puhekieli", prompt)
        self.assertIn("Mitä teit tänään?", prompt)

    def test_first_transcription_prompt_includes_opening_question(self) -> None:
        prompt = build_transcription_prompt("Arki", [])

        self.assertIn("Mitä sinulle kuuluu tänään?", prompt)


if __name__ == "__main__":
    unittest.main()