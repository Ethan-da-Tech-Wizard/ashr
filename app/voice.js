// Hold-to-talk with the browser's built-in speech recognition. No API key.
// Hold-to-talk dictation into a textarea via the browser's SpeechRecognition (audio handling is up to the browser).
// The button is disabled with a notice where the API does not exist.
//
// How it fits: app.js calls attachVoice for the 'say' sheet and the 'redo' sheet. Privacy note: in
// Chrome the browser sends the audio to its vendor's speech service; this app itself never sees or
// stores the audio, only the recognised text that lands in the textarea.
/**
 * @param {HTMLButtonElement|null} button - hold-to-talk button (pointer events, so it works for touch
 *   and mouse).
 * @param {HTMLTextAreaElement|null} textarea - receives the transcript; existing text is kept.
 * @returns {void} does nothing when either element is missing.
 */
export function attachVoice(button, textarea) {
  if (!button || !textarea) return;
  const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  if (!SR) {
    button.disabled = true;
    button.textContent = "voice not supported";
    return;
  }
  let rec = null;
  // Text already in the box when recording started; new speech is appended after it.
  let base = "";

  // Press: begin recognition. preventDefault stops the long-press text-selection menu on mobile.
  const start = (e) => {
    e.preventDefault();
    rec = new SR();
    rec.lang = "en-US";
    // Show partial results as the user speaks.
    rec.interimResults = true;
    rec.continuous = true;
    base = textarea.value ? `${textarea.value.trim()} ` : "";
    // The results list holds every phrase so far, so rebuild the whole transcript each time and
    // replace (not append) after the saved base text.
    rec.onresult = (ev) => {
      const text = Array.from(ev.results).map((r) => r[0].transcript).join("");
      textarea.value = base + text;
    };
    rec.onend = () => button.classList.remove("listening");
    rec.start();
    button.classList.add("listening");
    button.textContent = "listening…";
  };

  // Release or leave: stop recognition and restore the button label.
  const stop = () => {
    if (rec) rec.stop();
    rec = null;
    button.classList.remove("listening");
    button.textContent = "hold to talk";
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  // Also stop if the finger slides off the button.
  button.addEventListener("pointerleave", stop);
}
