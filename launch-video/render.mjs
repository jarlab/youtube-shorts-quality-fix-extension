// Renders video.html to MP4 with headless Chrome and macOS AVFoundation. No dependencies.
//
//   node render.mjs                       full render: out/launch.mp4, out/launch-720p.mp4 and out/poster.png
//   node render.mjs --stills 3.2,7.5      PNG stills for review, written to out/stills/
//   node render.mjs --from 5 --to 12      render part of the timeline, without sound
//   node render.mjs --mux                 put the current out/soundtrack.wav into existing renders
//   --workers 6                           parallel Chrome windows (default: half the cores, up to 6)
//
// Requires macOS, Google Chrome, Node.js 22+ and the Xcode command-line tools (swiftc).

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const width = 1920;
const height = 1080;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

// Each worker is a Chrome window rendering frames in parallel.
const workers = Number(option('workers', Math.min(6, Math.max(2, Math.floor(availableParallelism() / 2)))));
const stills = option('stills', null)?.split(',').map(Number);

function buildEncoder() {
  const binary = join(outDir, '.bin', 'encode');
  const source = join(here, 'encode.swift');
  if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
    mkdirSync(dirname(binary), { recursive: true });
    console.log('Compiling encode.swift…');
    execFileSync('swiftc', ['-O', source, '-o', binary], { stdio: 'inherit' });
  }
  return binary;
}

// Muxes out/soundtrack.wav, as AAC, with the video track of each source into its destination.
function muxSoundtrack(encoder, outputs) {
  const aac = join(outDir, 'soundtrack.m4a');
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '192000', '-q', '127', join(outDir, 'soundtrack.wav'), aac]);
  for (const [source, destination] of outputs) {
    const temp = `${destination}.muxing.mp4`;
    execFileSync(encoder, ['mux', source, aac, temp], { stdio: ['ignore', 'ignore', 'inherit'] });
    renameSync(temp, destination);
    console.log(`${basename(destination)}: ${(statSync(destination).size / 1e6).toFixed(1)} MB`);
  }
  unlinkSync(aac);
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'launch-video-chrome-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    // A persistent disk cache keeps Google Fonts between renders.
    `--disk-cache-dir=${join(outDir, '.chrome-cache')}`,
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--mute-audio',
    '--allow-file-access-from-files',
    // Never touch the macOS Keychain: a fresh profile would otherwise prompt for access.
    '--use-mock-keychain',
    '--password-store=basic',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-search-engine-choice-screen',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(chrome, 'exit');
  const removeProfile = () => {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  };
  // Chrome keeps writing to its profile until it has exited, so wait before removing it.
  const cleanup = async () => {
    chrome.kill('SIGKILL');
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
    removeProfile();
  };
  process.on('exit', () => { chrome.kill('SIGKILL'); removeProfile(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    chrome.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.on('exit', code => reject(new Error(`Chrome exited (${code}):\n${log}`)));
  });
  return { endpoint, cleanup };
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    });
  }

  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new DevTools(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
}

async function openPage(devtools) {
  // Each page gets its own window: background tabs are hidden and never finish loading fonts.
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => devtools.send(method, params, sessionId);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable');
  const url = `${pathToFileURL(join(here, 'video.html')).href}?capture`;
  // Wait for the page to exist (the Google Fonts stylesheet blocks it), then for fonts and images.
  // A font request can fail on a busy connection, so a failed load is retried.
  let info;
  for (let attempt = 1; !info; attempt++) {
    await send('Page.navigate', { url });
    const deadline = Date.now() + 60_000;
    try {
      for (;;) {
        try {
          if (await evaluate('typeof window.__ready') === 'object') break;
        } catch {}
        if (Date.now() > deadline) throw new Error('video.html did not load within 60 s; Google Fonts needs network access');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      info = await evaluate('window.__ready');
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Retrying video.html: ${error.message}`);
    }
  }
  const frame = async seconds => {
    await evaluate(`window.__seek(${seconds})`);
    const { data } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(data, 'base64');
  };
  return { info, frame };
}

async function renderStills(pages, times) {
  const dir = join(outDir, 'stills');
  mkdirSync(dir, { recursive: true });
  for (const [index, seconds] of times.entries()) {
    const image = await pages[index % pages.length].frame(seconds);
    const file = join(dir, `t${seconds.toFixed(2).padStart(6, '0')}.png`);
    writeFileSync(file, image);
    console.log(file);
  }
}

async function renderVideo(pages, { duration, fps }) {
  const encoder = buildEncoder();
  const from = Number(option('from', 0));
  const to = Math.min(Number(option('to', duration)), duration);
  const first = Math.round(from * fps);
  const total = Math.round(to * fps) - first;
  const video = join(outDir, 'video.mp4');
  const small = join(outDir, 'video-720p.mp4');
  // A 1080p60 master, and a 720p30 cut small enough to embed on GitHub (under 10 MB).
  const encoding = spawn(encoder, [
    String(fps),
    video, `${width}x${height}`, '12000000',
    small, '1280x720@30', '1350000',
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const encoded = once(encoding, 'exit');

  // Workers render frames in parallel; frames are written to the encoder strictly in order.
  const done = new Map();
  let nextToRender = 0;
  let nextToWrite = 0;
  let wake = null;
  const started = Date.now();
  const worker = async page => {
    while (nextToRender < total) {
      while (nextToRender - nextToWrite > pages.length * 4) await new Promise(resolve => setTimeout(resolve, 5));
      const index = nextToRender++;
      done.set(index, await page.frame((first + index) / fps));
      wake?.();
    }
  };
  const writer = async () => {
    while (nextToWrite < total) {
      if (!done.has(nextToWrite)) {
        await new Promise(resolve => { wake = resolve; setTimeout(resolve, 20); });
        continue;
      }
      const image = done.get(nextToWrite);
      done.delete(nextToWrite);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(image.length);
      if (!encoding.stdin.write(Buffer.concat([header, image]))) await once(encoding.stdin, 'drain');
      nextToWrite++;
      if (nextToWrite % fps === 0 || nextToWrite === total) {
        const rate = nextToWrite / ((Date.now() - started) / 1000);
        process.stdout.write(`\rFrame ${nextToWrite}/${total}  ${rate.toFixed(1)} fps  `);
      }
    }
    encoding.stdin.end();
  };
  await Promise.all([...pages.map(worker), writer()]);
  process.stdout.write('\n');
  const [code] = await encoded;
  if (code !== 0) throw new Error(`Encoder exited with ${code}`);

  if (from === 0 && to === duration && existsSync(join(outDir, 'soundtrack.wav'))) {
    muxSoundtrack(encoder, [[video, join(outDir, 'launch.mp4')], [small, join(outDir, 'launch-720p.mp4')]]);
    unlinkSync(video);
    unlinkSync(small);
  } else if (from !== 0 || to !== duration) {
    console.log('Partial render: wrote silent out/video.mp4 and out/video-720p.mp4.');
  } else {
    console.log('No out/soundtrack.wav, so the video is silent: run `node soundtrack.mjs` first.');
  }
}

mkdirSync(outDir, { recursive: true });
if (process.argv.includes('--mux')) {
  // Audio-only update: the frames are unchanged, so the renders keep their video tracks.
  const renders = ['launch.mp4', 'launch-720p.mp4'].map(name => join(outDir, name));
  for (const file of renders) if (!existsSync(file)) throw new Error(`${basename(file)} is missing: run a full render first`);
  if (!existsSync(join(outDir, 'soundtrack.wav'))) throw new Error('out/soundtrack.wav is missing: run node soundtrack.mjs first');
  muxSoundtrack(buildEncoder(), renders.map(file => [file, file]));
  process.exit(0);
}
const chrome = await launchChrome();
try {
  const devtools = await DevTools.connect(chrome.endpoint);
  const pages = await Promise.all(Array.from({ length: stills ? Math.min(workers, stills.length) : workers }, () => openPage(devtools)));
  if (stills) await renderStills(pages, stills);
  else {
    // Duration and frame rate come from timeline.js, via the page.
    await renderVideo(pages, pages[0].info);
    // Poster frame from a full render: the call to action, fully revealed.
    if (option('from', null) === null && option('to', null) === null) writeFileSync(join(outDir, 'poster.png'), await pages[0].frame(41));
  }
} finally {
  await chrome.cleanup();
}
