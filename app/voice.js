// Program: ashr - voice.js
// Programmer: Ethan-da-Tech-Wizard (written with Claude, an AI assistant)
// Last Modified: 2026-11-18
// Purpose: Adds hold-to-talk to a microphone button using the browser's speech recognition, writing the words into a text box.
// Hold-to-talk with the browser's built-in speech recognition. No API key.
/**
 * Connect a button to a text box for voice input.
 * @param {HTMLButtonElement} button the microphone button.
 * @param {HTMLTextAreaElement} textarea where the spoken words appear.
 */
export function attachVoice(button, textarea) {
  // Do nothing if either element is missing.
  if (!button || !textarea) return;
  // Find the browser's speech recognition class (it has two names).
  const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  // Browser has none: disable the button and say so.
  if (!SR) {
    button.disabled = true;
    button.textContent = "voice not supported";
    return;
  }
  // rec is the active recognizer; base is the text already in the box when talking starts.
  let rec = null;
  let base = "";

  // Button pressed: create a recognizer, keep typed text, and write live results after it.
  const start = (e) => {
    e.preventDefault();
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    base = textarea.value ? `${textarea.value.trim()} ` : "";
    // Join all results so far into one string and put it after the existing text.
    rec.onresult = (ev) => {
      const text = Array.from(ev.results).map((r) => r[0].transcript).join("");
      textarea.value = base + text;
    };
    rec.onend = () => button.classList.remove("listening");
    rec.start();
    button.classList.add("listening");
    button.textContent = "listening…";
  };

  // Button released: stop listening and reset the label.
  const stop = () => {
    if (rec) rec.stop();
    rec = null;
    button.classList.remove("listening");
    button.textContent = "hold to talk";
  };

  // Press starts, release or leaving the button stops.
  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointerleave", stop);
}
