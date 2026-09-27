// Procedural lo-fi soundtrack for the launch video, synthesised from the shared cue sheet.
//
//   node soundtrack.mjs      writes out/soundtrack.wav (48 kHz, 16-bit stereo)
//
// No samples or dependencies: every sound is generated here. The sound follows the picture's
// quality: muffled while the Short is 240p, fully open once it is 1080p. When voiceover.mjs has
// generated out/voice/, the narration is mixed in and the music ducks under it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { DURATION, BEAT, T, FEED, CHART } = createRequire(import.meta.url)('./timeline.js');
const SR = 48000;
const BAR = BEAT * 4;
const N = Math.round(DURATION * SR);
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, p) => a + (b - a) * p;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const midi = m => 440 * 2 ** ((m - 69) / 12);
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const noise = (() => { const r = rng(12345); return () => r() * 2 - 1; })();
const human = rng(777);
const bus = () => ({ l: new Float32Array(N), r: new Float32Array(N) });
function panGains(p) {
  const a = (clamp(p, -1, 1) + 1) * Math.PI / 4;
  return [Math.cos(a), Math.sin(a)];
}
function put(b, i, v, gl, gr) {
  if (i >= 0 && i < N) { b.l[i] += v * gl; b.r[i] += v * gr; }
}
// A 15 ms fade at the end of every voice, so no note is cut off with a click.
const tail = (i, len) => Math.min(1, (len - i) / (0.015 * SR));
function addInto(dst, src, gain = 1) {
  for (let i = 0; i < N; i++) { dst.l[i] += src.l[i] * gain; dst.r[i] += src.r[i] * gain; }
}

// RBJ biquad
class Biquad {
  constructor() { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set('lp', 1000, 0.707); }
  set(type, f, q) {
    const w = TAU * clamp(f, 10, SR * 0.45) / SR, c = Math.cos(w), a = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    else { b0 = a; b1 = 0; b2 = -a; }
    const a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = (-2 * c) / a0; this.a2 = (1 - a) / a0;
    return this;
  }
  run(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
function filterBus(b, type, cutoffAt, q = 0.707) {
  const fl = new Biquad(), fr = new Biquad();
  for (let i = 0; i < N; i++) {
    if (i % 32 === 0) { const f = typeof cutoffAt === 'function' ? cutoffAt(i / SR) : cutoffAt; fl.set(type, f, q); fr.set(type, f, q); }
    b.l[i] = fl.run(b.l[i]);
    b.r[i] = fr.run(b.r[i]);
  }
  return b;
}

// Freeverb-style stereo reverb.
class Comb {
  constructor(n) { this.buf = new Float32Array(n); this.i = 0; this.store = 0; }
  run(x, feedback, damp) {
    const y = this.buf[this.i];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * feedback;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}
class Allpass {
  constructor(n) { this.buf = new Float32Array(n); this.i = 0; }
  run(x) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}
function reverb(input, { room = 0.84, damp = 0.3 } = {}) {
  const scale = SR / 44100, spread = 23;
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const passes = [556, 441, 341, 225];
  const cl = combs.map(n => new Comb(Math.round(n * scale))), cr = combs.map(n => new Comb(Math.round((n + spread) * scale)));
  const al = passes.map(n => new Allpass(Math.round(n * scale))), ar = passes.map(n => new Allpass(Math.round((n + spread) * scale)));
  const out = bus();
  for (let i = 0; i < N; i++) {
    const x = (input.l[i] + input.r[i]) * 0.015;
    let l = 0, r = 0;
    for (let k = 0; k < 8; k++) { l += cl[k].run(x, room, damp); r += cr[k].run(x, room, damp); }
    for (let k = 0; k < 4; k++) { l = al[k].run(l); r = ar[k].run(r); }
    out.l[i] = l; out.r[i] = r;
  }
  return out;
}
// Reads `src` at a warped time `tau(t)`, for the record stop and the stall wobbles.
function warp(src, tau, gainAt = () => 1) {
  const out = bus();
  for (let i = 0; i < N; i++) {
    const t = i / SR, s = tau(t) * SR, j = Math.floor(s), f = s - j;
    if (!(j >= 0 && j + 1 < N)) continue;
    const g = gainAt(t);
    out.l[i] = (src.l[j] * (1 - f) + src.l[j + 1] * f) * g;
    out.r[i] = (src.r[j] * (1 - f) + src.r[j + 1] * f) * g;
  }
  return out;
}
// Log-interpolated automation through [time, value] keyframes.
function automation(keys) {
  return t => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let k = 1; k < keys.length; k++) {
      const [t1, v1] = keys[k];
      if (t <= t1) {
        const [t0, v0] = keys[k - 1];
        const p = (t - t0) / (t1 - t0);
        return v0 * (v1 / v0) ** p;
      }
    }
    return keys[keys.length - 1][1];
  };
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------
// FM electric piano with a tine attack and a slow stereo tremolo.
function ep(b, t0, note, vel, dur, p = 0) {
  const f = midi(note), w = TAU * f / SR, [gl, gr] = panGains(p);
  const i0 = Math.round(t0 * SR), len = Math.round((dur + 0.9) * SR);
  const decay = 1.1 + 1.8 * (60 / note) ** 2;
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const index = 0.22 + 1.35 * vel * Math.exp(-t / 0.28);
    const tine = Math.sin(ph * 14.2) * 0.07 * vel * Math.exp(-t / 0.014);
    const x = Math.sin(ph + index * Math.sin(ph)) + tine;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / decay) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.2));
    const trem = 0.14 * Math.sin(TAU * 4.1 * (t0 + t));
    put(b, i0 + i, x * env * vel * tail(i, len), gl * (1 + trem), gr * (1 - trem));
    ph += w;
  }
}
// Soft detuned pad for sustain under the piano.
const tri = ph => Math.sin(ph) - Math.sin(3 * ph) / 9 + Math.sin(5 * ph) / 25;
function pad(b, t0, note, dur, vel, p = 0) {
  const f = midi(note), [gl, gr] = panGains(p);
  const i0 = Math.round(t0 * SR), len = Math.round((dur + 1.2) * SR);
  let a = 0, c = 0;
  const wa = TAU * f * 2 ** (6 / 1200) / SR, wc = TAU * f * 2 ** (-6 / 1200) / SR;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.7) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.6));
    const g = env * vel * tail(i, len);
    put(b, i0 + i, (tri(a) * gl * 1.1 + tri(c) * gl * 0.4) * g, 1, 0);
    put(b, i0 + i, (tri(c) * gr * 1.1 + tri(a) * gr * 0.4) * g, 0, 1);
    a += wa; c += wc;
  }
}
function bassNote(b, t0, note, dur, vel) {
  const f = midi(note), w = TAU * f / SR;
  const i0 = Math.round(t0 * SR), len = Math.round((dur + 0.15) * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.006) * (0.6 + 0.4 * Math.exp(-t / 0.2)) * (t < dur ? 1 : Math.exp(-(t - dur) / 0.04));
    const x = Math.tanh(2.4 * (Math.sin(ph) + 0.35 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph))) / Math.tanh(2.4);
    put(b, i0 + i, x * env * vel * tail(i, len), 0.71, 0.71);
    ph += w;
  }
}
function kick(b, t0, vel = 1) {
  const i0 = Math.round(t0 * SR), len = Math.round(0.5 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += TAU * (44 + 95 * Math.exp(-t / 0.028)) / SR;
    const x = Math.sin(ph) * Math.exp(-t / 0.16) * Math.min(1, t / 0.0015) + noise() * Math.exp(-t / 0.0022) * 0.22;
    put(b, i0 + i, x * vel * tail(i, len), 0.71, 0.71);
  }
}
function snare(b, t0, vel = 1) {
  const bp = new Biquad().set('bp', 2600, 0.6), lp = new Biquad().set('lp', 8000, 0.7), hp = new Biquad().set('hp', 5000, 0.7);
  const i0 = Math.round(t0 * SR), len = Math.round(0.4 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += TAU * 188 / SR;
    const n = noise();
    const x = lp.run(bp.run(n)) * 2.2 * Math.exp(-t / 0.1) + hp.run(n) * 0.7 * Math.exp(-t / 0.05) + Math.sin(ph) * 0.4 * Math.exp(-t / 0.045);
    put(b, i0 + i, x * vel * tail(i, len), 0.71, 0.71);
  }
}
function hat(b, t0, vel = 1, open = false) {
  const hp = new Biquad().set('hp', 7000, 0.7);
  const decay = open ? 0.14 : 0.036, i0 = Math.round(t0 * SR), len = Math.round(decay * 7 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    put(b, i0 + i, hp.run(noise()) * Math.exp(-t / decay) * vel * tail(i, len), 0.62, 0.78);
  }
}
// FM bell for chimes and sparkles.
function bell(b, t0, note, vel = 0.3, p = 0, decay = 1.1) {
  const f = midi(note), w = TAU * f / SR, [gl, gr] = panGains(p);
  const i0 = Math.round(t0 * SR), len = Math.round(decay * 5 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const index = 0.3 + 1.8 * Math.exp(-t / 0.18);
    const x = Math.sin(ph + index * Math.sin(ph * 3.5)) * Math.exp(-t / decay) + Math.sin(ph * 2) * 0.25 * Math.exp(-t / (decay * 0.35));
    put(b, i0 + i, x * vel * Math.min(1, t / 0.002) * tail(i, len), gl, gr);
    ph += w;
  }
}
function whoosh(b, t0, dur, f0, f1, vel = 0.3, p0 = -0.4, p1 = 0.4) {
  const bp = new Biquad();
  const i0 = Math.round(t0 * SR), len = Math.round(dur * SR);
  for (let i = 0; i < len; i++) {
    const q = i / len;
    if (i % 32 === 0) bp.set('bp', f0 * (f1 / f0) ** q, 1.1);
    const [gl, gr] = panGains(lerp(p0, p1, q));
    put(b, i0 + i, bp.run(noise()) * Math.sin(Math.PI * q) ** 2 * vel * 3, gl, gr);
  }
}
function boom(b, t0, vel = 1) {
  const lp = new Biquad().set('lp', 180, 0.7);
  const i0 = Math.round(t0 * SR), len = Math.round(1.4 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += TAU * (36 + 48 * Math.exp(-t / 0.12)) / SR;
    const x = Math.sin(ph) * Math.exp(-t / 0.5) + lp.run(noise()) * 1.4 * Math.exp(-t / 0.18);
    put(b, i0 + i, x * vel * Math.min(1, t / 0.002) * tail(i, len), 0.71, 0.71);
  }
}
function crash(b, t0, vel = 0.3) {
  const hp = new Biquad().set('hp', 4200, 0.6), lp = new Biquad().set('lp', 12000, 0.6);
  const i0 = Math.round(t0 * SR), len = Math.round(2.4 * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const x = lp.run(hp.run(noise())) * (Math.exp(-t / 0.7) * 0.8 + Math.exp(-t / 0.06) * 0.6);
    put(b, i0 + i, x * vel * tail(i, len), 0.7 + 0.1 * Math.sin(t * 9), 0.7 - 0.1 * Math.sin(t * 9));
  }
}
function pop(b, t0, note, vel = 0.2, p = 0) {
  const f = midi(note), [gl, gr] = panGains(p);
  const i0 = Math.round(t0 * SR), len = Math.round(0.25 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += TAU * f * (1 + 0.6 * Math.exp(-t / 0.012)) / SR;
    put(b, i0 + i, Math.sin(ph) * Math.exp(-t / 0.05) * Math.min(1, t / 0.001) * vel * tail(i, len), gl, gr);
  }
}
function click(b, t0, vel = 0.25) {
  const bp = new Biquad().set('bp', 3200, 1.2);
  for (const [offset, v] of [[0, 1], [0.085, 0.6]]) {
    const i0 = Math.round((t0 + offset) * SR);
    for (let i = 0; i < 0.03 * SR; i++) put(b, i0 + i, bp.run(noise()) * Math.exp(-i / SR / 0.0035) * vel * v * 3, 0.6, 0.8);
  }
}
function bonk(b, t0, vel = 0.3) {
  const i0 = Math.round(t0 * SR), len = Math.round(0.3 * SR);
  let ph = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    ph += TAU * (210 * Math.exp(-t / 0.2) + 90) / SR;
    put(b, i0 + i, Math.sin(ph) * Math.exp(-t / 0.08) * vel * tail(i, len), 0.71, 0.71);
  }
}
function arpeggio(b, t0, notes, gap, vel, decay = 0.9, spread = 0.7) {
  notes.forEach((n, k) => bell(b, t0 + k * gap, n, vel * (0.75 + 0.25 * human()), lerp(-spread, spread, notes.length > 1 ? k / (notes.length - 1) : 0.5), decay));
}
function sparkles(b, t0, dur, count, vel, seed) {
  const r = rng(seed), scale = [84, 86, 89, 91, 93, 96, 98, 101];
  for (let k = 0; k < count; k++) bell(b, t0 + r() * dur, scale[Math.floor(r() * scale.length)], vel * (0.5 + r() * 0.5), r() * 1.6 - 0.8, 0.5);
}

// ---------------------------------------------------------------------------
// Score: I–vi–IV–V in F with ninths, one chord per bar.
// ---------------------------------------------------------------------------
const CHORDS = {
  F: { bass: 41, notes: [64, 67, 69, 72] },
  Dm: { bass: 38, notes: [65, 69, 72, 76] },
  Bb: { bass: 34, notes: [62, 65, 69, 72] },
  C: { bass: 36, notes: [65, 69, 70, 74] },
};
const BARS = ['Dm', 'Bb', 'C', 'F', 'Dm', 'Bb', 'C', 'F', 'Dm', 'Bb', 'C', 'F', 'Dm', 'Bb', 'C', 'F', 'Bb', 'F'];
const LAST = BARS.length - 1;
const at = (bar, beat) => bar * BAR + beat * BEAT;
const jitter = () => (human() - 0.5) * 0.012;

function comp(b, bar, velScale = 1) {
  const chord = CHORDS[BARS[bar]];
  const pans = [-0.35, -0.1, 0.12, 0.35];
  if (bar === LAST) {
    chord.notes.forEach((n, k) => ep(b, at(bar, 0) + k * 0.018, n, 0.5 * velScale, BAR * 1.1, pans[k]));
    ep(b, at(bar, 0.02), chord.notes[0] + 12, 0.28 * velScale, BAR, 0.2);
    return;
  }
  chord.notes.forEach((n, k) => ep(b, at(bar, 0) + k * 0.014 + jitter(), n, (0.5 + human() * 0.08) * velScale, BEAT * 1.9, pans[k]));
  chord.notes.slice(1).forEach((n, k) => ep(b, at(bar, 2.5) + k * 0.012 + jitter(), n, (0.34 + human() * 0.06) * velScale, BEAT * 1.2, pans[k + 1]));
}
function bassBar(b, bar) {
  const root = CHORDS[BARS[bar]].bass;
  if (bar === LAST) { bassNote(b, at(bar, 0), root, BAR * 0.9, 0.9); return; }
  bassNote(b, at(bar, 0), root, BEAT * 1.25, 0.95);
  bassNote(b, at(bar, 1.75), root, BEAT * 0.45, 0.6);
  bassNote(b, at(bar, 2.5), root + 12, BEAT * 0.8, 0.55);
  bassNote(b, at(bar, 3.5), root + 7, BEAT * 0.4, 0.5);
}
function drumBar(d, bar, light = false) {
  const swing = 0.08;
  const hats = [0.9, 0.45, 0.7, 0.5, 0.85, 0.45, 0.7, 0.55];
  for (let k = 0; k < 8; k++) {
    const beat = k / 2 + (k % 2 ? swing : 0);
    hat(d.hat, at(bar, beat) + jitter() * 0.5, hats[k] * (light ? 0.7 : 1), k === 7 && bar % 2 === 1);
  }
  kick(d.kick, at(bar, 0), 1);
  if (!light) { kick(d.kick, at(bar, 1.75), 0.7); kick(d.kick, at(bar, 2.5), 0.85); }
  snare(d.snare, at(bar, 1) + 0.006, 0.95);
  snare(d.snare, at(bar, 3) + 0.006, 1);
  if (bar % 4 === 2) snare(d.snare, at(bar, 3.75), 0.3);
}

// Intro: the 240p groove — piano only, muffled, with record wow, then a record stop on "Still 240p."
const intro = bus();
for (let bar = 0; bar < 2; bar++) comp(intro, bar, 0.95);
addInto(intro, reverb(intro, { room: 0.8 }), 0.35);
const stopLen = 0.6;
const introOut = warp(intro,
  t => {
    const wow = t + 0.0016 * Math.sin(TAU * 0.9 * t);
    if (t < T.stop) return wow;
    const d = t - T.stop;
    return d < stopLen ? T.stop + d - (d * d) / (2 * stopLen) : NaN;
  },
  t => (t < T.stop + stopLen - 0.18 ? 1 : 1 - prog(t, T.stop + stopLen - 0.18, T.stop + stopLen)) * prog(t, 0, 0.08));
filterBus(introOut, 'lp', 760, 0.9);

// Main groove from the wizard onwards.
const keys = bus(), bass = bus(), pads = bus();
const drums = { kick: bus(), snare: bus(), hat: bus() };
for (let bar = 2; bar < BARS.length; bar++) {
  comp(keys, bar, bar === 2 ? 0.8 : 1);
  if (bar >= 3) bassBar(bass, bar);
  if (bar >= 3 && bar < LAST) drumBar(drums, bar, bar === LAST - 1);
  if (bar >= 3) {
    const chord = CHORDS[BARS[bar]];
    const vel = bar >= 15 ? 0.05 : 0.03;
    chord.notes.forEach((n, k) => pad(pads, at(bar, 0), n - 12, BAR * (bar === LAST ? 1.1 : 1), vel, k % 2 ? 0.4 : -0.4));
  }
}
// The wizard's bar: a sustained build into the drop, with a snare roll.
pad(pads, T.wizard, 53, T.hd - T.wizard, 0.035, -0.3);
pad(pads, T.wizard, 57, T.hd - T.wizard, 0.035, 0.3);
[0, 0.25, 0.5, 0.75].forEach((b, k) => snare(drums.snare, at(2, 3 + b), 0.25 + k * 0.17));
filterBus(keys, 'lp', 5200, 0.7);
filterBus(keys, 'hp', 140, 0.7);
filterBus(drums.hat, 'lp', 11000, 0.7);
filterBus(pads, 'lp', 1600, 0.7);
filterBus(drums.kick, 'lp', 5000, 0.7);

const music = bus();
addInto(music, keys, 0.19);
addInto(music, bass, 0.19);
addInto(music, pads, 1);
addInto(music, drums.kick, 0.36);
addInto(music, drums.snare, 0.3);
addInto(music, drums.hat, 0.16);
const send = bus();
addInto(send, keys, 0.2);
addInto(send, pads, 0.6);
addInto(send, drums.snare, 0.12);
addInto(music, reverb(send), 0.45);

// Stalls in the chart wobble the music like a buffering stream, with no net drift.
const wobble = 0.06, wobbleLen = 0.4;
const stallTimes = CHART.stalls.map(s => CHART.timeOf(s));
const mainOut = warp(music, t => {
  for (const s of stallTimes) {
    if (t > s && t < s + wobbleLen) return t - (wobble * wobbleLen / TAU) * (1 - Math.cos(TAU * (t - s) / wobbleLen));
  }
  return t;
});
// The music's "resolution": muffled until the fix, then dipping whenever the picture drops quality.
const open = 20000;
const qualityKeys = [
  [T.wizard, 520], [T.impact, 1500], [T.impact + 0.7, open],
  [FEED[1].swipe + 0.15, open], [FEED[1].swipe + 0.45, 3000], [FEED[1].fix, 3000], [FEED[1].fix + 0.25, open],
  [FEED[2].swipe + 0.15, open], [FEED[2].swipe + 0.45, 3000], [FEED[2].fix, 3000], [FEED[2].fix + 0.25, 11000],
  [FEED[3].swipe + 0.15, 11000], [FEED[3].swipe + 0.45, 3600], [FEED[3].fix, 3600], [FEED[3].fix + 0.25, open],
  [CHART.timeOf(CHART.weakS), open], [stallTimes[0], 2400], [CHART.dropT, 2000], [CHART.dropT + 0.3, 3600], [CHART.upT, 3600], [CHART.upT + 0.35, open],
];
filterBus(mainOut, 'lp', automation(qualityKeys), 0.85);

// ---------------------------------------------------------------------------
// Sound effects, on cue with the picture.
// ---------------------------------------------------------------------------
const sfx = bus();
// 1 · the problem
pop(sfx, T.stat1, 84, 0.1, -0.3);
pop(sfx, T.stat2, 86, 0.1, -0.3);
boom(sfx, T.stat3, 0.2);
pop(sfx, T.stat3, 64, 0.16, -0.2);
// 2 · the fix
arpeggio(sfx, T.wizard, [72, 74, 77, 79, 81, 84, 86, 89, 91], 0.04, 0.15, 1.1);
whoosh(sfx, T.wizard - 0.05, 0.55, 400, 3200, 0.22, -0.6, -0.2);
bell(sfx, T.glint, 96, 0.14, -0.2, 0.7);
bell(sfx, T.glint + 0.12, 101, 0.08, -0.3, 0.6);
whoosh(sfx, T.beam, T.impact - T.beam + 0.08, 700, 7000, 0.3, -0.5, 0.6);
sparkles(sfx, T.beam, T.impact - T.beam, 9, 0.08, 3);
boom(sfx, T.impact, 0.5);
[77, 81, 84, 91].forEach((n, k) => bell(sfx, T.impact + k * 0.006, n, 0.16, (k - 1.5) * 0.3, 1.4));
crash(sfx, T.impact, 0.18);
[1, 2, 3].forEach(k => pop(sfx, T.impact + k * 0.075, 84 + k * 3, 0.06, 0.5));
whoosh(sfx, T.impact + 0.05, T.hd - T.impact - 0.05, 900, 9000, 0.12, -0.2, 0.2);
crash(sfx, T.hd, 0.2);
// 3 · title
crash(sfx, T.title, 0.14);
arpeggio(sfx, T.title + 0.25, [84, 88, 91, 96], 0.08, 0.14, 1.3, 0.5);
// 4 · the menu
whoosh(sfx, T.menu - 0.05, 0.45, 300, 2200, 0.2, -0.8, -0.3);
click(sfx, T.click, 0.22);
whoosh(sfx, T.poof, 0.45, 1500, 8000, 0.16, -0.6, -0.2);
sparkles(sfx, T.poof, 0.35, 10, 0.06, 5);
[79, 81, 84, 86].forEach((n, k) => pop(sfx, T.chipTimes[k], n, 0.12, 0.2 + k * 0.1));
// 5 · feed
for (const s of FEED.slice(1)) {
  whoosh(sfx, s.swipe - 0.02, 0.5, 2600, 700, 0.13, 0.5, 0.2);
  if (s.best === 1080) { bell(sfx, s.fix, 84, 0.14, 0.5, 0.8); bell(sfx, s.fix + 0.08, 91, 0.12, 0.6, 0.9); }
  else bell(sfx, s.fix, 88, 0.12, 0.5, 0.8);
}
// 6 · adaptation
whoosh(sfx, T.adapt - 0.05, 0.4, 400, 2400, 0.14, -0.6, 0);
stallTimes.forEach(s => bonk(sfx, s, 0.22));
bell(sfx, CHART.dropT, 81, 0.13, 0, 0.7);
bell(sfx, CHART.dropT + 0.13, 76, 0.13, 0, 0.9);
arpeggio(sfx, CHART.upT, [76, 81, 84, 88], 0.06, 0.13, 0.9, 0.4);
sparkles(sfx, CHART.upT + 0.1, 0.4, 5, 0.06, 7);
// 7 · good manners
T.cards.forEach((c, k) => pop(sfx, c, [79, 83, 86][k], 0.12, (k - 1) * 0.5));
pop(sfx, T.manifest, 91, 0.07, 0);
// 8 · call to action
whoosh(sfx, T.cta - 0.4, 0.45, 500, 6000, 0.16, -0.3, 0.3);
boom(sfx, T.cta, 0.32);
crash(sfx, T.cta, 0.16);
arpeggio(sfx, T.cta, [72, 76, 79, 84, 88, 91, 96, 100], 0.05, 0.16, 1.4, 0.8);
bell(sfx, T.tagline, 88, 0.12, 0.3, 1);
bell(sfx, T.tagline + 0.1, 93, 0.1, 0.4, 1.1);
T.pills.forEach((p, k) => pop(sfx, p, [84, 88][k], 0.09, k ? 0.3 : -0.3));
sparkles(sfx, at(LAST, 0), 1.2, 7, 0.05, 9);
addInto(sfx, reverb(sfx, { room: 0.86, damp: 0.25 }), 0.5);

// Vinyl crackle: louder in the 240p intro, a quiet bed after that.
const crackle = bus();
{
  const r = rng(99), bp = new Biquad().set('bp', 2400, 0.6), hl = new Biquad().set('lp', 5200, 0.7), hr = new Biquad().set('lp', 5200, 0.7);
  let pulse = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    if (r() < 7 / SR) pulse = (r() < 0.5 ? -1 : 1) * (0.25 + r() ** 2 * 0.75);
    const c = bp.run(pulse);
    pulse *= 0.5;
    const level = t < T.stop ? 1 : t < T.wizard ? 0.55 : 0.4;
    crackle.l[i] = (c * 0.9 + hl.run(r() * 2 - 1) * 0.035) * level;
    crackle.r[i] = (c * 0.8 + hr.run(r() * 2 - 1) * 0.035) * level;
  }
}

// ---------------------------------------------------------------------------
// Voiceover
// ---------------------------------------------------------------------------
function readWav(path) {
  const buf = readFileSync(path);
  let offset = 12, rate = 0, channels = 1, bits = 0, data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4), size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(offset + 10); rate = buf.readUInt32LE(offset + 12); bits = buf.readUInt16LE(offset + 22); }
    if (id === 'data') data = buf.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error(`${path}: expected a 16-bit PCM WAV`);
  const frames = Math.floor(data.length / (2 * channels)), samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += data.readInt16LE((i * channels + c) * 2);
    samples[i] = s / channels / 32768;
  }
  return { rate, samples };
}
// Doubles the sample rate with a Blackman-windowed sinc interpolator.
function upsample2(x) {
  const taps = 24, h = new Float32Array(2 * taps);
  for (let k = 0; k < 2 * taps; k++) {
    const d = k - taps + 0.5;
    h[k] = (Math.sin(Math.PI * d) / (Math.PI * d)) * (0.42 + 0.5 * Math.cos(Math.PI * d / taps) + 0.08 * Math.cos(2 * Math.PI * d / taps));
  }
  const y = new Float32Array(x.length * 2);
  for (let n = 0; n < x.length; n++) {
    y[2 * n] = x[n];
    let acc = 0;
    for (let k = 0; k < 2 * taps; k++) {
      const j = n + k - taps + 1;
      if (j >= 0 && j < x.length) acc += x[j] * h[k];
    }
    y[2 * n + 1] = acc;
  }
  return y;
}

const voice = bus();
const duck = new Float32Array(N);
const voiceDir = join(here, 'out', 'voice');
const narration = existsSync(join(voiceDir, 'manifest.json')) ? JSON.parse(readFileSync(join(voiceDir, 'manifest.json'), 'utf8')) : null;
const smooth = p => p * p * (3 - 2 * p);
if (narration) {
  for (const line of narration.lines) {
    const { rate, samples } = readWav(join(voiceDir, line.file));
    if (rate !== SR && rate * 2 !== SR) throw new Error(`${line.file}: unsupported sample rate ${rate}`);
    const clip = rate === SR ? samples : upsample2(samples);
    const hp = new Biquad().set('hp', 80, 0.707);
    for (let i = 0; i < clip.length; i++) clip[i] = hp.run(clip[i]);
    // Every line at the same speech level.
    let sum = 0, count = 0;
    for (const x of clip) if (Math.abs(x) > 0.01) { sum += x * x; count++; }
    const level = 0.1 / Math.sqrt(sum / Math.max(1, count));
    const i0 = Math.round(line.at * SR);
    for (let i = 0; i < clip.length; i++) put(voice, i0 + i, clip[i] * level, 0.71, 0.71);
    // The music dips just before each line and recovers after it.
    const a = line.at - 0.12, b = line.at + clip.length / SR + 0.25;
    for (let i = Math.max(0, Math.floor((a - 0.2) * SR)); i < Math.min(N, Math.ceil((b + 0.45) * SR)); i++) {
      const t = i / SR;
      duck[i] = Math.max(duck[i], Math.min(smooth(prog(t, a - 0.2, a)), 1 - smooth(prog(t, b, b + 0.45))));
    }
  }
  addInto(voice, reverb(voice, { room: 0.55, damp: 0.5 }), 0.09);
}

// ---------------------------------------------------------------------------
// Mix and master
// ---------------------------------------------------------------------------
const mix = bus();
for (let i = 0; i < N; i++) {
  const music = 1 - 0.55 * duck[i], effects = 1 - 0.5 * duck[i];
  mix.l[i] = (introOut.l[i] * 0.3 + mainOut.l[i]) * music + sfx.l[i] * effects + crackle.l[i] * 0.05;
  mix.r[i] = (introOut.r[i] * 0.3 + mainOut.r[i]) * music + sfx.r[i] * effects + crackle.r[i] * 0.05;
}
if (narration) {
  // Speech sits about 5 dB over the undipped music, so about 12 dB over the dipped bed.
  let music = 0, speech = 0, speaking = 0;
  for (let i = 0; i < N; i++) {
    music += mix.l[i] ** 2 + mix.r[i] ** 2;
    const v = voice.l[i] ** 2 + voice.r[i] ** 2;
    if (v > 2e-4) { speech += v; speaking++; }
  }
  const gain = (Math.sqrt(music / N) * 10 ** (5 / 20)) / Math.sqrt(speech / Math.max(1, speaking));
  addInto(mix, voice, gain);
}
filterBus(mix, 'hp', 28, 0.707);
filterBus(mix, 'lp', 15000, 0.707);
const fadeStart = T.end - 1.1, fadeEnd = T.end - 0.1;
let sumSquares = 0;
for (let i = 0; i < N; i++) {
  const g = 1 - prog(i / SR, fadeStart, fadeEnd) ** 1.5;
  mix.l[i] *= g; mix.r[i] *= g;
  sumSquares += mix.l[i] ** 2 + mix.r[i] ** 2;
}
// Level to about -17 dBFS RMS, then a gentle soft clip keeps peaks under -1 dBFS.
const rms = Math.sqrt(sumSquares / (2 * N));
const gain = 10 ** (-17 / 20) / rms;
const ceiling = 10 ** (-1 / 20);
let peak = 0, clipped = 0;
const out = new Int16Array(N * 2);
const dither = rng(4242);
for (let i = 0; i < N; i++) {
  for (const [c, x0] of [[0, mix.l[i]], [1, mix.r[i]]]) {
    let x = x0 * gain;
    const a = Math.abs(x);
    if (a > 0.7) { x = Math.sign(x) * (0.7 + (ceiling - 0.7) * Math.tanh((a - 0.7) / (ceiling - 0.7))); clipped++; }
    peak = Math.max(peak, Math.abs(x));
    out[i * 2 + c] = Math.round(clamp(x * 32767 + (dither() - dither()), -32768, 32767));
  }
}
if (!Number.isFinite(rms) || rms === 0) throw new Error('Soundtrack rendered silence');

function wav(samples) {
  const data = Buffer.from(samples.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
mkdirSync(join(here, 'out'), { recursive: true });
const file = join(here, 'out', 'soundtrack.wav');
writeFileSync(file, wav(out));
console.log(`Wrote ${file}: ${DURATION} s, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS, ${(100 * clipped / (2 * N)).toFixed(2)}% of samples softened, ${narration ? `${narration.lines.length} voiceover lines (${narration.voice})` : 'no voiceover (run node voiceover.mjs)'}`);
