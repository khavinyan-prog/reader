// Read-aloud engine on top of speechSynthesis: one utterance per sentence.
// A generation counter makes sure late events from cancelled utterances never move the position,
// so sentences are never skipped or repeated.
const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;

const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|deranged|hysterical|pipe organ)\b/i;

export function voiceScore(v) {
  let s = 0;
  // iOS reports quality in the voice id too, e.g. com.apple.voice.premium.en-US.Zoe
  const n = v.name + ' ' + (v.voiceURI || '');
  if (/natural|neural/i.test(n)) s += 100;
  if (/online/i.test(n)) s += 60;
  if (/premium/i.test(n)) s += 90;
  if (/enhanced|improved|משופר/i.test(n)) s += 80;
  if (/siri/i.test(n)) s += 70;
  if (/google/i.test(n)) s += 35;
  if (/^(ava|zoe|samantha|allison|evan|nathan|tom|susan|serena|daniel|karen|moira|tessa|alex)\b/i.test(n)) s += 15;
  if (/en[-_]US/i.test(v.lang)) s += 10;
  else if (/en[-_]GB/i.test(v.lang)) s += 8;
  else s += 4;
  if (NOVELTY.test(n) || /eloquence|espeak/i.test(n)) s -= 200;
  if (v.default) s += 2;
  return s;
}

export function englishVoices() {
  if (!synth) return [];
  return synth.getVoices()
    .filter((v) => /^en([-_]|$)/i.test(v.lang))
    .map((v) => ({ v, score: voiceScore(v) }))
    .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

export function isQualityVoice(v) {
  return voiceScore(v) >= 60;
}

// Voices arrive late (iOS, Chrome). Calls cb every time the list may have changed.
export function watchVoices(cb) {
  if (!synth) return;
  let last = -1;
  const check = () => {
    const n = synth.getVoices().length;
    if (n !== last) { last = n; cb(); }
  };
  if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', check);
  check();
  let tries = 0;
  const iv = setInterval(() => { check(); if (++tries > 40) clearInterval(iv); }, 250);
}

export class Player {
  // hooks: sentence(id) -> {text}|null (sync), loadSentence(id) -> Promise, next(id) -> Promise<id|null>,
  //        onSentence(id), onWord(id, start, end), onState(state)
  constructor(hooks) {
    this.h = hooks;
    this.gen = 0;
    this.cur = null;
    this.playing = false;
    this.rate = 1;
    this.voice = null;
    this.u = null;
    this.timer = null;
    this.nextCache = null;
  }

  get supported() { return !!synth; }

  play(id) {
    if (!synth) return;
    this.cur = id;
    this.playing = true;
    this.h.onState('playing');
    this.speakCurrent();
  }

  toggle() {
    if (this.playing) this.pause();
    else if (this.cur) this.play(this.cur);
  }

  pause() {
    this.playing = false;
    this.gen++;
    clearTimeout(this.timer);
    if (synth) synth.cancel();
    this.h.onState('paused');
  }

  stop() {
    this.pause();
  }

  setRate(r) {
    this.rate = r;
    if (this.playing) this.play(this.cur);
  }

  setVoice(v) {
    this.voice = v;
    if (this.playing) this.play(this.cur);
  }

  async jump(dir, count = 1) {
    if (!this.cur) return;
    let id = this.cur;
    for (let i = 0; i < count; i++) {
      const n = await this.h.next(id, dir);
      if (!n) break;
      id = n;
    }
    if (id === this.cur) return;
    if (this.playing) this.play(id);
    else { this.cur = id; this.h.onSentence(id, false); }
  }

  speakCurrent() {
    const gen = ++this.gen;
    clearTimeout(this.timer);
    const id = this.cur;
    const s = this.h.sentence(id);
    if (!s) {
      // Not extracted yet: load it, then continue (only if nothing else happened meanwhile).
      this.h.loadSentence(id).then(() => { if (gen === this.gen && this.playing) this.speakCurrent(); });
      return;
    }
    this.h.onSentence(id, true);
    const text = s.text;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this.rate;
    if (this.voice) { u.voice = this.voice; u.lang = this.voice.lang; } else u.lang = 'en-US';
    let lastEvent = Date.now();
    u.onstart = () => { lastEvent = Date.now(); };
    u.onboundary = (e) => {
      if (gen !== this.gen) return;
      lastEvent = Date.now();
      if (e.name && e.name !== 'word') return;
      const start = e.charIndex;
      if (typeof start !== 'number' || start < 0 || start >= text.length) return;
      let end = e.charLength > 0 ? start + e.charLength : -1;
      if (end < 0) {
        const m = /^[^\s]+/.exec(text.slice(start));
        end = start + (m ? m[0].length : 1);
      }
      this.h.onWord(id, start, Math.min(end, text.length));
    };
    u.onend = () => {
      if (gen !== this.gen) return;
      this.advance(gen);
    };
    u.onerror = (e) => {
      if (gen !== this.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') { this.playing = false; this.gen++; this.h.onState('blocked'); return; }
      // Voice or engine problem on this sentence: wait a moment, then move on.
      setTimeout(() => { if (gen === this.gen) this.advance(gen); }, 400);
    };
    this.u = u; // keep a reference: Chrome can garbage-collect utterances and drop onend
    const go = () => { if (gen === this.gen) synth.speak(u); };
    if (synth.speaking || synth.pending) {
      synth.cancel();
      setTimeout(go, 60); // Chrome sometimes ignores speak() right after cancel()
    } else {
      go();
    }
    // Watchdog for engines that lose the end event.
    const expected = (text.length / (13 * this.rate)) * 1000;
    const check = () => {
      if (gen !== this.gen) return;
      if (synth.paused && this.playing) synth.resume();
      const quiet = Date.now() - lastEvent;
      if (!synth.speaking && !synth.pending && quiet > 1500) { this.advance(gen); return; }
      this.timer = setTimeout(check, 2000);
    };
    this.timer = setTimeout(check, expected * 1.6 + 5000);
    // Prepare the following sentence so the switch is instant.
    this.h.next(id, 1).then((n) => { this.nextCache = { from: id, to: n }; if (n) this.h.loadSentence(n); });
  }

  async advance(gen) {
    clearTimeout(this.timer);
    let n;
    if (this.nextCache && this.nextCache.from === this.cur) n = this.nextCache.to;
    else n = await this.h.next(this.cur, 1);
    if (gen !== this.gen || !this.playing) return;
    if (!n) {
      this.playing = false;
      this.gen++;
      this.h.onState('ended');
      return;
    }
    this.cur = n;
    this.speakCurrent();
  }
}
