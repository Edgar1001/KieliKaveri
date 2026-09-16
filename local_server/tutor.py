from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class HistoryTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    transcript: str = Field(max_length=600)
    reply: str = Field(max_length=600)


class TutorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    correctedText: str = Field(
        min_length=1,
        max_length=600,
        description="The learner's corrected sentence in Finnish.",
    )
    explanation: str = Field(
        min_length=1,
        max_length=600,
        description="One brief correction explanation in English only, never Finnish.",
    )
    reply: str = Field(
        min_length=1,
        max_length=600,
        description="A short, natural conversational response in Finnish ending in one question.",
    )
    translation: str = Field(
        min_length=1,
        max_length=600,
        description="A concise English translation of the Finnish reply.",
    )


Topic = Literal["Arki", "Kahvila", "Työ"]
Level = Literal["A2", "B1", "B2", "C1", "C2"]
LanguageMode = Literal["Puhekieli", "Kirjakieli"]

TOPIC_GUIDANCE = {
    "Arki": "everyday life, errands, hobbies, friends, and home",
    "Kahvila": "ordering, paying, preferences, and friendly cafe small talk",
    "Työ": "workdays, meetings, colleagues, projects, and professional small talk",
}

TOPIC_GUIDANCE_FINNISH = {
    "Arki": "arjesta",
    "Kahvila": "kahvilassa",
    "Työ": "työstä",
}

OPENING_QUESTION = "Hei! Mitä sinulle kuuluu tänään?"

LEVEL_GUIDANCE = {
    "A2": "Use short, concrete sentences and common vocabulary. Keep the reply below 25 words.",
    "B1": "Use clear connected sentences and everyday vocabulary. Keep the reply below 40 words.",
    "B2": "Use natural, varied Finnish with some idiomatic vocabulary. Keep the reply below 55 words.",
    "C1": "Use nuanced, fluent Finnish with precise vocabulary and varied structures. Keep the reply below 70 words.",
    "C2": "Use highly natural, precise Finnish with register-sensitive, native-like phrasing. Keep the reply below 85 words.",
}

MODE_GUIDANCE = {
    "Puhekieli": "Use natural neutral Finnish puhekieli in correctedText and reply. Accept established spoken forms such as mä, sä, mun, sun, tuun, meen, oon, and haluun; do not correct them merely for being colloquial.",
    "Kirjakieli": "Use standard written Finnish kirjakieli in correctedText and reply. Convert colloquial forms to their standard equivalents when correction is needed.",
}


def build_transcription_prompt(
    topic: Topic,
    history: list[HistoryTurn],
    language_mode: LanguageMode = "Puhekieli",
) -> str:
    prompt = f"Suomenkielinen {language_mode.lower()} keskustelu {TOPIC_GUIDANCE_FINNISH[topic]}."
    previous_question = history[-1].reply if history else OPENING_QUESTION
    prompt += f" {previous_question}"
    return prompt


def build_tutor_prompt(
    topic: Topic,
    history: list[HistoryTurn],
    level: Level = "B2",
    language_mode: LanguageMode = "Puhekieli",
) -> str:
    previous_turns = "\n".join(
        f"Learner: {turn.transcript}\nTutor: {turn.reply}" for turn in history
    ) or "No previous turns."

    return f"""You are Kielikaveri, a meticulous Finnish conversation tutor for a CEFR {level} learner.
Keep a natural conversation about {TOPIC_GUIDANCE[topic]}. The learner's latest utterance is supplied separately.
{LEVEL_GUIDANCE[level]}
{MODE_GUIDANCE[language_mode]}

Return JSON with exactly four fields:
- correctedText: natural, corrected Finnish. If it is already natural, repeat it exactly.
- explanation: one brief, encouraging explanation in English. If no correction is needed, say "That sounds natural." Do not claim to assess pronunciation from a transcript.
- reply: a short Finnish response that continues the conversation and ends with one easy question.
- translation: a concise, natural English translation of reply.

The explanation field must be in English only. The correctedText and reply fields must be in {language_mode} Finnish.
The translation field must be in English only and must translate reply faithfully, without adding information.
Never overwhelm the learner: explain only the most important correction, while correctedText must fix every clear error.
Before answering, silently verify person, number, tense, mood, case government, object case, agreement, word order, and whether the correction preserves the learner's intended meaning.
Never change grammatical person or factual meaning. If uncertain whether wording is wrong, preserve it rather than inventing a correction.
Never name a grammar case unless you are certain; a simple usage explanation is better than an incorrect label.
Transcripts may contain obvious speech-recognition errors or joined words. Repair them only when the intended Finnish is clear, and never repeat a malformed word in the reply.
Use ordinary vocabulary directly related to the learner's meaning. Do not invent details or introduce unrelated words.
Respond directly to questions before continuing the conversation. Avoid generic phrases that do not fit the preceding utterance.

Example input: Minä haluan yksi kahvi.
Example output: {{"correctedText":"Minä haluan yhden kahvin.","explanation":"Use 'yhden kahvin' when asking for one whole coffee.","reply":"Totta kai. Haluatko kahviin maitoa tai sokeria?"}}

Recent conversation:
{previous_turns}"""