// Headless browsers have no voices: a fake speechSynthesis that fires start, word boundaries and end on a timer.
(() => {
  const log = (window.__ttsLog = []);
  const voices = [
    { name: 'Microsoft David - English (United States)', lang: 'en-US', voiceURI: 'david', localService: true, default: true },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', voiceURI: 'aria', localService: false, default: false },
    { name: 'Google UK English Female', lang: 'en-GB', voiceURI: 'g-uk', localService: false, default: false },
    { name: 'Microsoft Asaf - Hebrew (Israel)', lang: 'he-IL', voiceURI: 'asaf', localService: true, default: false },
  ];
  class FakeUtterance { constructor(text) { this.text = text; this.rate = 1; this.voice = null; this.lang = ''; } }
  const synth = {
    speaking: false, pending: false, paused: false, queue: [], cur: null, timer: null,
    getVoices() { return voices; },
    addEventListener() {}, onvoiceschanged: null,
    speak(u) {
      if (window.__dropNext) { window.__dropNext = false; log.push({ ev: 'dropped', text: u.text, t: Date.now() }); return; }
      this.queue.push(u); this.pending = true; if (!this.cur) this._next(); },
    _next() {
      const u = this.queue.shift();
      this.pending = this.queue.length > 0;
      if (!u) { this.cur = null; this.speaking = false; return; }
      this.cur = u; this.speaking = true;
      log.push({ ev: 'speak', text: u.text, rate: u.rate, voice: u.voice && u.voice.name, t: Date.now() });
      const words = [...u.text.matchAll(/\S+/g)];
      let i = 0;
      const fire = (name, props) => { const f = u['on' + name]; if (f) f(Object.assign({ name: props.name, charIndex: props.charIndex, charLength: props.charLength, error: props.error }, {})); };
      setTimeout(() => {
        if (this.cur !== u) return;
        fire('start', {});
        const step = () => {
          if (this.cur !== u) return;
          if (i < words.length) {
            fire('boundary', { name: 'word', charIndex: words[i].index, charLength: words[i][0].length });
            i++;
            this.timer = setTimeout(step, window.__wordMs || 30);
          } else {
            this.cur = null; this.speaking = false;
            fire('end', {});
            if (!this.cur) this._next();
          }
        };
        step();
      }, 15);
    },
    cancel() {
      const u = this.cur; this.queue = []; this.pending = false; this.cur = null; this.speaking = false;
      clearTimeout(this.timer);
      log.push({ ev: 'cancel', t: Date.now() });
      if (u && u.onerror) u.onerror({ error: 'interrupted' });
    },
    pause() { this.paused = true; }, resume() { this.paused = false; },
  };
  // Something outside the app (a call, Siri) stops the speech.
  window.__interrupt = () => {
    const u = synth.cur;
    if (!u) return false;
    synth.cur = null; synth.speaking = false; clearTimeout(synth.timer);
    log.push({ ev: 'external-interrupt', text: u.text, t: Date.now() });
    if (u.onerror) u.onerror({ error: 'interrupted' });
    return true;
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
})();
