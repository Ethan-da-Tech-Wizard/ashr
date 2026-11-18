// Hold-to-talk with the browser's built-in speech recognition. No API key.
export function attachVoice(button, textarea) {
  if (!button || !textarea) return;
  const SR = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
  if (!SR) {
    button.disabled = true;
    button.textContent = "voice not supported";
    return;
  }
  let rec = null;
  let base = "";

  const start = (e) => {
    e.preventDefault();
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = true;
    base = textarea.value ? `${textarea.value.trim()} ` : "";
    rec.onresult = (ev) => {
      const text = Array.from(ev.results).map((r) => r[0].transcript).join("");
      textarea.value = base + text;
    };
    rec.onend = () => button.classList.remove("listening");
    rec.start();
    button.classList.add("listening");
    button.textContent = "listening…";
  };

  const stop = () => {
    if (rec) rec.stop();
    rec = null;
    button.classList.remove("listening");
    button.textContent = "hold to talk";
  };

  button.addEventListener("pointerdown", start);
  button.addEventListener("pointerup", stop);
  button.addEventListener("pointerleave", stop);
}
