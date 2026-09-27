// Voiceover for the launch video, read by Kokoro-82M: an open-weight neural text-to-speech model
// (Apache 2.0, https://huggingface.co/hexgrad/Kokoro-82M) running locally through kokoro-js.
//
//   npm install                   once, for kokoro-js
//   node voiceover.mjs            writes out/voice/: one clip per NARRATION line in timeline.js,
//                                 and manifest.json, which soundtrack.mjs mixes under the music
//   node voiceover.mjs --samples  writes out/voice-samples/: one passage in several female voices
//   --voice af_heart              voice to read with (default af_heart)
//   --speed 0.92                  base speaking rate; a line that overruns its slot is read faster
//   --check                       transcribes every clip with Whisper, to confirm what was said
//
// The models download from Hugging Face on first use (Kokoro about 330 MB, Whisper about 80 MB)
// and are cached in node_modules.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KokoroTTS } from 'kokoro-js';

const here = dirname(fileURLToPath(import.meta.url));
const { DURATION, NARRATION } = createRequire(import.meta.url)('./timeline.js');

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}
const flag = name => process.argv.includes(`--${name}`);

const voice = option('voice', 'af_heart');
const baseSpeed = Number(option('speed', 0.92));
const maxSpeed = 1.1;
const gap = 0.12;
const SAMPLE_VOICES = ['af_heart', 'af_bella', 'af_nicole', 'bf_emma'];
const SAMPLE_TEXT = 'No more digging through quality menus. Install it once, and just watch. Sit back. It’s ten-eighty p.';

// Removes the model's leading and trailing silence, keeping a little air around the words.
function trim(samples, rate) {
  const threshold = 0.003;
  let start = 0, end = samples.length - 1;
  while (start < end && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  start = Math.max(0, start - Math.round(0.02 * rate));
  end = Math.min(samples.length - 1, end + Math.round(0.06 * rate));
  const clip = samples.slice(start, end + 1);
  const fade = Math.round(0.008 * rate);
  for (let i = 0; i < fade; i++) {
    clip[i] *= i / fade;
    clip[clip.length - 1 - i] *= i / fade;
  }
  return clip;
}

function wav(samples, rate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((x, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

console.log('Loading Kokoro-82M…');
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu' });
if (!(voice in tts.voices)) throw new Error(`Unknown voice ${voice}. Female English voices: ${Object.keys(tts.voices).filter(v => /^[ab]f_/.test(v)).join(', ')}`);

if (flag('samples')) {
  const dir = join(here, 'out', 'voice-samples');
  mkdirSync(dir, { recursive: true });
  for (const name of SAMPLE_VOICES) {
    const audio = await tts.generate(SAMPLE_TEXT, { voice: name, speed: baseSpeed });
    writeFileSync(join(dir, `${name}.wav`), wav(trim(audio.audio, audio.sampling_rate), audio.sampling_rate));
    console.log(join(dir, `${name}.wav`), `(${tts.voices[name].name}, grade ${tts.voices[name].overallGrade})`);
  }
} else {
  const clips = await readNarration();
  if (flag('check')) await check(clips);
}

// Reads every NARRATION line into out/voice/, speeding up any line that would overrun its slot.
async function readNarration() {
  const dir = join(here, 'out', 'voice');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const manifest = { voice, lines: [] };
  const clips = [];
  for (const [index, line] of NARRATION.entries()) {
    const end = line.until ?? (NARRATION[index + 1] ? NARRATION[index + 1].at - gap : DURATION - 1.5);
    const room = end - line.at;
    let speed = baseSpeed, clip, rate;
    for (;;) {
      const audio = await tts.generate(line.text, { voice, speed });
      rate = audio.sampling_rate;
      clip = trim(audio.audio, rate);
      const length = clip.length / rate;
      if (length <= room || speed >= maxSpeed) break;
      speed = Math.min(maxSpeed, speed * (length / room) * 1.03);
    }
    const length = clip.length / rate;
    const file = `${String(index + 1).padStart(2, '0')}.wav`;
    writeFileSync(join(dir, file), wav(clip, rate));
    manifest.lines.push({ file, text: line.text, at: line.at, length: +length.toFixed(3), speed: +speed.toFixed(3) });
    clips.push({ file, clip, rate });
    const over = length > room ? `  overruns its slot by ${(length - room).toFixed(2)} s` : '';
    console.log(`${file}  ${line.at.toFixed(2)}–${(line.at + length).toFixed(2)} s  speed ${speed.toFixed(2)}  ${line.text}${over}`);
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${manifest.lines.length} clips to ${dir}`);
  return clips;
}

// Transcribes each clip with Whisper, to confirm what the voice actually said.
async function check(clips) {
  const { pipeline } = await import('@huggingface/transformers');
  const asr = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-base.en', { dtype: 'q8', device: 'cpu' });
  for (const { file, clip, rate } of clips) {
    // Whisper listens at 16 kHz.
    const ratio = rate / 16000, input = new Float32Array(Math.floor(clip.length / ratio));
    for (let i = 0; i < input.length; i++) {
      const p = i * ratio, j = Math.floor(p), f = p - j;
      input[i] = clip[j] * (1 - f) + (clip[j + 1] ?? 0) * f;
    }
    const { text } = await asr(input);
    console.log(`${file}  heard: ${text.trim()}`);
  }
}
