#!/usr/bin/env python3
"""Make the sound effects and a music bed with plain maths, no outside service.

Used by demo/sound.py when the ElevenLabs key may not make effects or music.
Writes 44.1 kHz WAV files into demo/audio/. Needs numpy and scipy.
"""
from __future__ import annotations

import os

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, lfilter, lfilter_zi

RATE = 44100
AUDIO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio")
RNG = np.random.default_rng(7)


def t(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * RATE)) / RATE


def decay(seconds: float, half_life: float) -> np.ndarray:
    return np.exp(-t(seconds) * np.log(2) / half_life)


def fade(x: np.ndarray, fade_in: float = 0.005, fade_out: float = 0.02) -> np.ndarray:
    y = x.copy()
    a, b = int(fade_in * RATE), int(fade_out * RATE)
    if a:
        y[:a] *= np.linspace(0, 1, a)
    if b:
        y[-b:] *= np.linspace(1, 0, b)
    return y


def lowpass(x: np.ndarray, cutoff: float, order: int = 2) -> np.ndarray:
    b, a = butter(order, min(cutoff, RATE * 0.45) / (RATE / 2), "low")
    return lfilter(b, a, x)


def highpass(x: np.ndarray, cutoff: float) -> np.ndarray:
    b, a = butter(2, cutoff / (RATE / 2), "high")
    return lfilter(b, a, x)


def swept_noise(seconds: float, cutoffs: list[float]) -> np.ndarray:
    """White noise through a low-pass whose cutoff moves along `cutoffs`."""
    noise = RNG.standard_normal(int(seconds * RATE))
    chunks = np.array_split(noise, 40)
    curve = np.interp(np.linspace(0, 1, len(chunks)), np.linspace(0, 1, len(cutoffs)), cutoffs)
    out, state = [], None
    for chunk, cutoff in zip(chunks, curve):
        b, a = butter(2, cutoff / (RATE / 2), "low")
        state = lfilter_zi(b, a) * chunk[0] if state is None else state
        y, state = lfilter(b, a, chunk, zi=state)
        out.append(y)
    return np.concatenate(out)


def sweep(seconds: float, f0: float, f1: float) -> np.ndarray:
    freq = np.linspace(f0, f1, int(seconds * RATE))
    return np.sin(2 * np.pi * np.cumsum(freq) / RATE)


def bell(freq: float, seconds: float, half_life: float) -> np.ndarray:
    x = t(seconds)
    tone = np.sin(2 * np.pi * freq * x) + 0.35 * np.sin(2 * np.pi * freq * 2.01 * x) + 0.12 * np.sin(2 * np.pi * freq * 3.9 * x)
    return tone * decay(seconds, half_life)


def place(total: float, parts: list[tuple[float, np.ndarray]]) -> np.ndarray:
    out = np.zeros(int(total * RATE))
    for start, part in parts:
        i = int(start * RATE)
        part = part[: len(out) - i]
        out[i:i + len(part)] += part
    return out


def tap() -> np.ndarray:
    body = sweep(0.05, 1700, 800) * decay(0.05, 0.008)
    click = highpass(RNG.standard_normal(int(0.012 * RATE)), 3000) * decay(0.012, 0.003) * 0.4
    return fade(place(0.09, [(0, body), (0, click)]), 0.001, 0.02)


def whoosh() -> np.ndarray:
    x = swept_noise(0.75, [300, 1200, 4200, 2000, 500])
    return fade(highpass(x, 180) * np.hanning(len(x)) ** 1.5, 0.01, 0.05)


def deny() -> np.ndarray:
    thud = sweep(0.55, 95, 42) * decay(0.55, 0.11)
    flare = swept_noise(1.3, [2600, 1500, 700, 300]) * decay(1.3, 0.28) * 0.5
    return fade(place(1.5, [(0, thud), (0.05, flare)]), 0.002, 0.2)


def allow() -> np.ndarray:
    return fade(place(1.3, [(0, bell(659.25, 1.0, 0.16) * 0.7), (0.13, bell(987.77, 1.1, 0.2) * 0.7)]), 0.002, 0.2)


def redirect() -> np.ndarray:
    x = t(0.8)
    note = (np.sin(2 * np.pi * 440 * x) + 0.3 * np.sin(2 * np.pi * 1760 * x)) * decay(0.8, 0.07)
    return fade(note * 0.8, 0.002, 0.1)


def intro() -> np.ndarray:
    rise = swept_noise(2.1, [200, 500, 1500, 5000]) * np.linspace(0, 1, int(2.1 * RATE)) ** 2 * 0.35
    hum = sweep(2.1, 55, 110) * np.linspace(0, 1, int(2.1 * RATE)) ** 2 * 0.4
    hit = sweep(1.2, 70, 50) * decay(1.2, 0.3) + chord([110, 164.81, 220, 329.63], 1.2) * decay(1.2, 0.35) * 0.5
    return fade(place(3.3, [(0, rise), (0, hum), (2.1, hit)]), 0.05, 0.3)


def chord(freqs: list[float], seconds: float) -> np.ndarray:
    """A soft pad: two slightly detuned saw waves per note, rolled off."""
    x = t(seconds)
    out = np.zeros(len(x))
    for f in freqs:
        for detune in (0.997, 1.003):
            out += 2 * ((f * detune * x) % 1) - 1
    return lowpass(out / (2 * len(freqs)), 900)


def music(seconds: float = 60.0, bpm: float = 100.0) -> np.ndarray:
    beat = 60 / bpm
    bar = 4 * beat
    # A minor 7, F major 7, C major, G major: two bars each.
    chords = [
        ([220.0, 261.63, 329.63, 392.0], 110.0),
        ([174.61, 220.0, 261.63, 329.63], 87.31),
        ([196.0, 261.63, 329.63, 392.0], 130.81),
        ([196.0, 246.94, 293.66, 392.0], 98.0),
    ]
    out = np.zeros(int(seconds * RATE))
    total_bars = int(seconds / bar) + 1
    for index in range(0, total_bars, 2):
        notes, root = chords[(index // 2) % len(chords)]
        start = index * bar
        if start >= seconds:
            break
        swell = np.minimum(1, t(2 * bar) / 0.6) * np.minimum(1, (2 * bar - t(2 * bar)) / 0.6)
        pad = chord(notes, 2 * bar) * swell * 0.5
        parts = [(start, pad)]
        for step in range(16):  # eighth notes over two bars
            when = start + step * beat / 2
            if when < 5.0:      # the bass waits for the title to finish
                continue
            pulse = np.sin(2 * np.pi * root * t(0.22)) * decay(0.22, 0.06) * (0.55 if step % 2 == 0 else 0.32)
            parts.append((when, pulse))
            if when >= 13.0 and step % 2 == 1:   # light tick on the off-beat once the story starts
                tick = highpass(RNG.standard_normal(int(0.03 * RATE)), 6000) * decay(0.03, 0.006) * 0.12
                parts.append((when, tick))
            if when >= 25.0 and step % 4 == 0:   # soft kick from the first decision
                kick = sweep(0.18, 110, 45) * decay(0.18, 0.05) * 0.5
                parts.append((when, kick))
        for when, part in parts:
            i = int(when * RATE)
            part = part[: len(out) - i]
            if len(part) > 0:
                out[i:i + len(part)] += part
    return fade(out, 1.0, 3.0)


def save(name: str, x: np.ndarray, peak: float = 0.9) -> None:
    os.makedirs(AUDIO, exist_ok=True)
    x = x / (np.max(np.abs(x)) or 1) * peak
    wavfile.write(os.path.join(AUDIO, f"{name}.wav"), RATE, (x * 32767).astype(np.int16))


def make_effects() -> None:
    for name, maker in {"fx-tap": tap, "fx-whoosh": whoosh, "fx-deny": deny, "fx-allow": allow,
                        "fx-redirect": redirect, "fx-intro": intro}.items():
        save(name, maker())


def make_music() -> None:
    save("music", music(), 0.8)


if __name__ == "__main__":
    make_effects()
    make_music()
    print("wrote effects and music to", AUDIO)
