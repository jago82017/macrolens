// Speech-to-text via the Web Speech API (Chrome on Android sends audio to Google for recognition).

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const voiceSupported = !!SR;

/** Start listening. onText(text, isFinal) fires as words arrive; returns a stop() function. */
export function listen({ onText, onEnd, lang = navigator.language || 'en-US' }) {
  const rec = new SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let ended = false;
  const end = err => { if (!ended) { ended = true; onEnd?.(err); } };
  rec.onresult = e => {
    let text = '';
    for (const r of e.results) text += r[0].transcript;
    onText?.(text.trim(), e.results[e.results.length - 1].isFinal);
  };
  rec.onerror = e => end(e.error);
  rec.onend = () => end();
  try { rec.start(); } catch (e) { end(e.message); }
  return () => { try { rec.stop(); } catch { /* already stopped */ } };
}
