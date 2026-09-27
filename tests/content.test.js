const assert = require('node:assert/strict');
const test = require('node:test');
const { QualityPolicy, QualityRequests, standardLevels, bufferAhead, deliveredQualityMatches, install } = require('../content.js');

const levels = ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

function scenario(overrides = {}) {
  const policy = new QualityPolicy();
  let now = 0;
  let sample = {
    videoId: 'first', levels, active: true, seeking: false,
    stalled: false, buffer: 20, ...overrides,
  };
  const tick = (changes = {}, seconds = 1) => {
    sample = { ...sample, ...changes };
    let result;
    for (let i = 0; i < seconds; i++) {
      now += 1000;
      result = policy.observe({ ...sample, now });
    }
    return result;
  };
  tick();
  return { policy, tick };
}

test('prefers standard 1080p and excludes Premium, Auto and resolutions above the ceiling', () => {
  const choices = standardLevels([
    { quality: 'hd1080', qualityLabel: '1080p Premium', isPlayable: true, paygatedQualityDetails: {} },
    { quality: 'hd1080', qualityLabel: '1080p', isPlayable: true },
    { quality: 'hd2160', qualityLabel: '2160p', isPlayable: true },
    { quality: 'hd720', qualityLabel: '720p', isPlayable: true },
    { quality: 'large', qualityLabel: '480p', isPlayable: false },
  ]);
  assert.deepEqual(choices, ['hd1080', 'hd720']);
  assert.deepEqual(standardLevels(['auto', 'small', 'hd2160', 'hd720']), ['hd720', 'small']);
  assert.equal(scenario().tick().quality, 'hd1080');
});

test('uses the highest available lower resolution without mistaking it for a slow connection', () => {
  const s = scenario({ levels: ['large', 'hd720', 'medium'] });
  assert.equal(s.tick().quality, 'hd720');
  assert.equal(s.tick({ videoId: 'second', levels }).quality, 'hd1080');
});

test('one brief interruption keeps HD; two sustained interruptions lower it by one level', () => {
  const s = scenario();
  s.tick({}, 6);
  assert.equal(s.tick({ stalled: true, buffer: 0 }, 2).quality, 'hd1080');
  s.tick({ stalled: false, buffer: 20 }, 2);
  assert.equal(s.tick({ stalled: true, buffer: 0 }, 2).quality, 'hd720');
  assert.equal(s.tick({ stalled: false, buffer: 20 }).quality, 'hd720');
});

test('one long interruption lowers quality and a continuing stall can lower it again after the grace period', () => {
  const s = scenario();
  s.tick({}, 6);
  assert.equal(s.tick({ stalled: true, buffer: 0 }, 8).quality, 'hd720');
  assert.equal(s.tick({}, 7).quality, 'hd720');
  assert.equal(s.tick({}, 9).quality, 'large');
});

test('paused, hidden, seeking, and startup periods do not trigger a network downgrade', () => {
  for (const excluded of [{ active: false }, { seeking: true }]) {
    const s = scenario();
    assert.equal(s.tick({ stalled: true, buffer: 0, ...excluded }, 50).quality, 'hd1080');
  }
  const s = scenario();
  assert.equal(s.tick({ stalled: true, buffer: 0 }, 4).quality, 'hd1080');
});

test('seeking clears interruption history and grants a fresh settling period', () => {
  const s = scenario();
  s.tick({}, 6);
  s.tick({ stalled: true, buffer: 0 }, 2);
  s.tick({ seeking: true });
  assert.equal(s.tick({ seeking: false }, 5).quality, 'hd1080');
  assert.equal(s.tick({}, 2).quality, 'hd1080');
});

test('old interruptions expire from the downgrade window', () => {
  const s = scenario();
  s.tick({}, 6);
  s.tick({ stalled: true, buffer: 0 }, 2);
  s.tick({ stalled: false, buffer: 10 }, 31);
  assert.equal(s.tick({ stalled: true, buffer: 0 }, 2).quality, 'hd1080');
});

test('healthy playback upgrades toward HD and fallback survives a Short change', () => {
  const s = scenario();
  s.tick({}, 6);
  s.tick({ stalled: true, buffer: 0 }, 8);
  assert.equal(s.tick({ videoId: 'second', stalled: false, buffer: 20 }).quality, 'hd720');
  assert.equal(s.tick({}, 40).quality, 'hd1080');
});

test('a failed upgrade falls back and cannot retry for sixty seconds', () => {
  const s = scenario();
  s.tick({}, 6);
  s.tick({ stalled: true, buffer: 0 }, 8);
  assert.equal(s.tick({ stalled: false, buffer: 20 }, 40).quality, 'hd1080');
  assert.equal(s.tick({ stalled: true, buffer: 0 }, 8).quality, 'hd720');
  assert.equal(s.tick({ stalled: false, buffer: 20 }, 59).quality, 'hd720');
  assert.equal(s.tick({}, 2).quality, 'hd1080');
});

test('recovery can accumulate over short clips when the whole remainder is buffered', () => {
  const s = scenario();
  s.tick({}, 6);
  s.tick({ stalled: true, buffer: 0 }, 8);
  for (let i = 0; i < 4; i++) {
    s.tick({ videoId: `clip-${i}`, stalled: false, buffer: 8, fullyBuffered: true }, 15);
  }
  assert.equal(s.tick().quality, 'hd1080');
});

test('missing buffer measurements and a full buffer do not falsely lower quality', () => {
  for (const buffer of [null, 20]) {
    const s = scenario();
    const result = s.tick({ buffer, stalled: true }, 60);
    assert.equal(result.height, 1080);
    assert.equal(result.quality, buffer === null ? null : 'hd1080');
  }
});

test('manual choice suspends automation for this video only', () => {
  const s = scenario();
  s.policy.manualOverride();
  assert.equal(s.tick({}, 60).quality, null);
  assert.equal(s.tick({ videoId: 'second' }).quality, 'hd1080');
});

test('buffer calculation uses only the contiguous range around the playhead and playback rate', () => {
  const ranges = { length: 2, start: i => [0, 50][i], end: i => [10, 80][i] };
  assert.equal(bufferAhead(ranges, 5, 2), 2.5);
  assert.equal(bufferAhead(ranges, 30, 1), 0);
  assert.equal(bufferAhead(ranges, 60, 2), 10);
  assert.equal(bufferAhead(null, 0, 1), null);
});

test('verification requires decoded HD as well as the player label, including portrait and ultrawide video', () => {
  assert.equal(deliveredQualityMatches('hd1080', 'hd1080', 1080, 1920), true);
  assert.equal(deliveredQualityMatches('hd1080', 'hd1080', 1920, 800), true);
  assert.equal(deliveredQualityMatches('hd1080', 'hd1080', 240, 426), false);
  assert.equal(deliveredQualityMatches('hd1080', 'small', 1080, 1920), false);
  assert.equal(deliveredQualityMatches('hd1080', 'hd1080', 0, 0), false);
});

test('an ineffective player gets only three requests before automation stops', () => {
  const requests = new QualityRequests();
  let count = 0;
  for (let now = 0; now <= 60_000; now += 1000) {
    count += Number(requests.next({ target: 'hd1080', reported: 'small', width: 240, height: 426, now, playing: true }));
  }
  assert.equal(count, 3);
  assert.equal(requests.stopped, true);
});

test('verification does not time out while the user has paused playback', () => {
  const requests = new QualityRequests();
  let count = 0;
  for (let now = 0; now <= 300_000; now += 1000) {
    count += Number(requests.next({ target: 'hd1080', reported: 'small', width: 240, height: 426, now, playing: false }));
  }
  assert.equal(count, 1);
  assert.equal(requests.stopped, false);
});

function fakePage({ effective = true } = {}) {
  let now = 0;
  let quality = 'small';
  let videoId = 'first';
  const calls = [];
  const warnings = [];
  const timers = new Set();
  const listeners = new Map();
  const classes = new Set();
  const video = {
    paused: true, ended: false, seeking: false, readyState: 4,
    currentTime: 70, duration: 173, playbackRate: 1.5, muted: true, volume: 0.35,
    videoWidth: 240, videoHeight: 426,
    buffered: { length: 1, start: () => 0, end: () => 100 },
  };
  const player = {
    getVideoData: () => ({ video_id: videoId, isLive: false }),
    querySelector: () => video,
    getAvailableQualityLevels: () => levels,
    getPlaybackQuality: () => quality,
    classList: { contains: name => classes.has(name) },
    contains: item => item === 'quality-item',
    setPlaybackQualityRange: target => {
      calls.push(target);
      if (effective) {
        quality = target;
        video.videoWidth = target === 'hd1080' ? 1080 : 720;
        video.videoHeight = target === 'hd1080' ? 1920 : 1280;
      }
    },
  };
  const page = {
    document: {
      visibilityState: 'visible',
      getElementById: () => player,
      addEventListener: (name, listener) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
      },
      removeEventListener: (name, listener) => listeners.get(name).delete(listener),
    },
    location: { href: 'https://www.youtube.com/shorts/first' },
    performance: { now: () => now },
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: callback => timers.delete(callback),
    console: { warn: text => warnings.push(text) },
  };
  return {
    page, video, player, calls, classes, warnings, timers, listeners,
    tick(seconds = 1) {
      for (let i = 0; i < seconds; i++) {
        now += 1000;
        for (const callback of timers) callback();
      }
    },
    navigate(id) {
      videoId = id;
      page.location.href = `https://www.youtube.com/shorts/${id}`;
      quality = 'small';
      video.videoWidth = 240;
      video.videoHeight = 426;
    },
    clickQuality() {
      const event = { isTrusted: true, type: 'click', target: { closest: () => 'quality-item' } };
      for (const callback of listeners.get('click')) callback(event);
    },
  };
}

test('content integration corrects quality automatically without touching playback and installs once', () => {
  const f = fakePage();
  const before = { time: f.video.currentTime, paused: f.video.paused, speed: f.video.playbackRate, muted: f.video.muted, volume: f.video.volume };
  const controller = install(f.page);
  assert.equal(install(f.page), controller);
  f.tick();
  assert.equal(controller.status().verified, true);
  assert.deepEqual(f.calls, ['hd1080']);
  assert.deepEqual({ time: f.video.currentTime, paused: f.video.paused, speed: f.video.playbackRate, muted: f.video.muted, volume: f.video.volume }, before);
  assert.equal(f.timers.size, 1);
  controller.destroy();
  assert.equal(f.timers.size, 0);
  assert.equal([...f.listeners.values()].every(set => set.size === 0), true);
});

test('manual override survives player updates but resets when the next Short becomes active', () => {
  const f = fakePage();
  const controller = install(f.page);
  f.tick();
  f.clickQuality();
  f.tick();
  assert.equal(controller.status().state, 'manual');
  assert.equal(controller.status().target, null);
  f.navigate('second');
  f.tick(2);
  assert.equal(controller.status().verified, true);
  assert.deepEqual(f.calls, ['hd1080', 'hd1080']);
});

test('hidden tabs and ads do not receive quality requests', () => {
  const f = fakePage();
  f.page.document.visibilityState = 'hidden';
  install(f.page);
  f.tick(30);
  assert.deepEqual(f.calls, []);
  f.page.document.visibilityState = 'visible';
  f.classes.add('ad-showing');
  f.tick(30);
  assert.deepEqual(f.calls, []);
  f.classes.clear();
  f.tick();
  assert.deepEqual(f.calls, ['hd1080']);
});

test('integration gives up on an ineffective API and emits one local warning', () => {
  const f = fakePage({ effective: false });
  f.video.paused = false;
  const controller = install(f.page);
  f.tick(60);
  assert.equal(controller.status().state, 'unsupported');
  assert.deepEqual(f.calls, ['hd1080', 'hd1080', 'hd1080', 'auto']);
  assert.equal(f.warnings.length, 1);
});

test('changing the requested target cannot bypass the consecutive failure limit', () => {
  const requests = new QualityRequests();
  const observed = { reported: 'small', width: 240, height: 426, playing: true };
  assert.equal(requests.next({ ...observed, target: 'hd1080', now: 0 }), true);
  assert.equal(requests.next({ ...observed, target: 'hd720', now: 10_000 }), true);
  assert.equal(requests.next({ ...observed, target: 'large', now: 20_000 }), true);
  assert.equal(requests.next({ ...observed, target: 'medium', now: 30_000 }), false);
  assert.equal(requests.stopped, true);
});

test('missing playback observations do not force quality', () => {
  const f = fakePage();
  f.video.buffered = null;
  install(f.page);
  f.tick(20);
  assert.deepEqual(f.calls, []);
});

test('stale players belonging to another URL are left untouched', () => {
  const f = fakePage();
  f.page.location.href = 'https://www.youtube.com/shorts/second';
  install(f.page);
  f.tick(20);
  assert.deepEqual(f.calls, []);
});

test('backgrounding a stalled video resets the interruption rather than extending it on return', () => {
  const f = fakePage();
  f.video.paused = false;
  f.video.readyState = 2;
  f.video.buffered.end = () => 70;
  const controller = install(f.page);
  f.tick(5);
  f.page.document.visibilityState = 'hidden';
  f.tick(60);
  f.page.document.visibilityState = 'visible';
  f.tick(7);
  assert.equal(controller.status().target, 'hd1080');
  f.tick();
  assert.equal(controller.status().target, 'hd720');
});
