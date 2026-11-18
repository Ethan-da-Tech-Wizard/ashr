#!/usr/bin/env python3
"""Add voice-over, sound effects and music to the 60-second animation.

Reads docs/demo-60s.mp4, writes docs/demo-60s-sound.mp4.
The voice comes from ElevenLabs. Sound effects are made on the laptop (demo/synth.py).
Music is asked from ElevenLabs first and made on the laptop if the key may not do that.
Every clip is cached in demo/audio/, so a re-mix costs nothing.
Needs ELEVENLABS_API_KEY in the environment (only when a voice clip is missing) and ffmpeg.

    python3 demo/sound.py            # make missing clips, then mix
    python3 demo/sound.py --mix      # mix only, from the cached clips
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(ROOT, "demo", "audio")
VIDEO_IN = os.path.join(ROOT, "docs", "demo-60s.mp4")
VIDEO_OUT = os.path.join(ROOT, "docs", "demo-60s-sound.mp4")
API = "https://api.elevenlabs.io"
VOICE_NAME = "Brian"                    # calm, low, American
VOICE_FALLBACK = "nPczCjzI2devNBz1zQrb"
LENGTH = 60.0

# (start second, latest end second, file name, words). "Asher" is how the name is said aloud.
VOICE = [
    (0.6, 5.2, "vo-1-title", "This is Asher. It keeps your coding agents in order."),
    (5.9, 12.8, "vo-2-problem", "You start a few agents and walk away. One by one, they stop, and wait for permission."),
    (13.3, 17.9, "vo-3-card", "Asher sends each request to your phone, in plain English."),
    (18.4, 25.0, "vo-4-ask", "Not sure what it means? Tap once to see why it was flagged, and what a model thinks."),
    (25.6, 33.6, "vo-5-deny", "A risky one? Swipe left to deny it, and tell the agent why."),
    (34.3, 36.4, "vo-6a-allow", "A safe one? Swipe right."),
    (38.3, 40.7, "vo-6b-allow", "The agent carries on."),
    (41.3, 49.7, "vo-7-redirect", "Or tell it what to do instead, and send it a better plan."),
    (50.3, 55.3, "vo-8-owners", "Every agent shows who owns it, and which agent it is."),
    (55.9, 59.8, "vo-9-end", "Asher. Safe commands pass. Risky ones ask you first."),
]

# (second, effect, volume) matched to demo/record.py
CUES = [
    (0.0, "fx-intro", 0.55), (4.5, "fx-whoosh", 0.35),
    (19.35, "fx-tap", 0.8), (21.55, "fx-tap", 0.8), (24.75, "fx-tap", 0.8),
    (27.1, "fx-whoosh", 0.45), (29.55, "fx-tap", 0.8), (30.95, "fx-tap", 0.8), (31.05, "fx-deny", 0.8),
    (36.5, "fx-whoosh", 0.45), (37.7, "fx-allow", 0.75),
    (43.15, "fx-tap", 0.8), (45.15, "fx-tap", 0.8), (46.55, "fx-tap", 0.8), (46.65, "fx-redirect", 0.8),
    (55.4, "fx-intro", 0.5),
]
MUSIC = ("music", "Minimal modern electronic underscore for a tech product demo. Warm soft synth bass pulse, airy pads, "
         "light clicky percussion, confident and calm, around 100 bpm. Builds gently, then a clean soft ending.")


def call(path: str, body: dict, query: str = "") -> bytes:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("ELEVENLABS_API_KEY is not set, and a clip is missing. Use --mix to mix cached clips only.")
    req = urllib.request.Request(f"{API}{path}{query}", data=json.dumps(body).encode(),
                                 headers={"xi-api-key": key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return res.read()
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"ElevenLabs refused {path}: {err.code} {err.read().decode()[:200]}") from err


def voice_id() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    try:
        req = urllib.request.Request(f"{API}/v1/voices", headers={"xi-api-key": key})
        with urllib.request.urlopen(req, timeout=30) as res:
            for voice in json.load(res).get("voices", []):
                if voice.get("name", "").split(" ")[0] == VOICE_NAME:
                    return voice["voice_id"]
    except (urllib.error.URLError, ValueError):
        pass
    return VOICE_FALLBACK


def clip(name: str) -> str:
    """Path of a cached clip: the mp3 from ElevenLabs if there is one, else the wav made here."""
    mp3 = os.path.join(AUDIO, f"{name}.mp3")
    return mp3 if os.path.exists(mp3) else os.path.join(AUDIO, f"{name}.wav")


def make_clips() -> None:
    os.makedirs(AUDIO, exist_ok=True)
    vid = None
    for _start, _end, name, words in VOICE:
        if not os.path.exists(clip(name)):
            vid = vid or voice_id()
            body = {"text": words, "model_id": "eleven_multilingual_v2",
                    "voice_settings": {"stability": 0.5, "similarity_boost": 0.75, "style": 0.15}}
            open(clip(name), "wb").write(call(f"/v1/text-to-speech/{vid}", body, "?output_format=mp3_44100_128"))
            print("made", name)
    if not all(os.path.exists(clip(name)) for _second, name, _volume in CUES):
        synth.make_effects()
        print("made the sound effects on this laptop")
    if not os.path.exists(clip(MUSIC[0])):
        try:
            body = {"prompt": MUSIC[1], "music_length_ms": int(LENGTH * 1000), "force_instrumental": True}
            data = call("/v1/music", body)
            open(os.path.join(AUDIO, f"{MUSIC[0]}.mp3"), "wb").write(data)
            print("made the music with ElevenLabs")
        except RuntimeError as err:
            print(str(err)[:160])
            synth.make_music()
            print("made the music on this laptop instead")


def seconds_of(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def mix() -> None:
    inputs, filters, voice_tags, fx_tags = ["-i", VIDEO_IN], [], [], []
    n = 1
    for start, end, name, _words in VOICE:
        length = seconds_of(clip(name))
        room = end - start
        tempo = min(max(length / room, 1.0), 1.25)  # speed up a little only if the line overruns its scene
        if length / tempo > room + 0.05:
            print(f"warning: {name} is {length:.1f}s for a {room:.1f}s scene")
        inputs += ["-i", clip(name)]
        filters.append(f"[{n}:a]atempo={tempo:.3f},adelay={int(start * 1000)}:all=1[v{n}]")
        voice_tags.append(f"[v{n}]")
        print(f"{name}: {length:.1f}s in a {room:.1f}s scene" + (f", sped up x{tempo:.2f}" if tempo > 1 else ""))
        n += 1
    for second, name, volume in CUES:
        inputs += ["-i", clip(name)]
        filters.append(f"[{n}:a]volume={volume},adelay={int(second * 1000)}:all=1[f{n}]")
        fx_tags.append(f"[f{n}]")
        n += 1
    inputs += ["-i", clip(MUSIC[0])]
    fade_out = LENGTH - 2.5
    filters += [
        f"{''.join(voice_tags)}amix=inputs={len(voice_tags)}:normalize=0,apad=whole_dur={LENGTH},asplit=2[vo][key]",
        f"{''.join(fx_tags)}amix=inputs={len(fx_tags)}:normalize=0,apad=whole_dur={LENGTH}[fx]",
        f"[{n}:a]atrim=0:{LENGTH},volume=0.5,afade=t=in:d=1.2,afade=t=out:st={fade_out}:d=2.5,apad=whole_dur={LENGTH}[bed]",
        "[bed][key]sidechaincompress=threshold=0.03:ratio=8:attack=40:release=450[duck]",   # music dips under the voice
        f"[vo][fx][duck]amix=inputs=3:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,atrim=0:{LENGTH}[out]",
    ]
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters),
                    "-map", "0:v", "-map", "[out]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                    "-t", str(LENGTH), "-movflags", "+faststart", VIDEO_OUT], check=True)
    print("wrote", VIDEO_OUT, f"{os.path.getsize(VIDEO_OUT) / 1e6:.1f} MB, {seconds_of(VIDEO_OUT):.1f}s")


if __name__ == "__main__":
    if "--mix" not in sys.argv:
        make_clips()
    mix()
