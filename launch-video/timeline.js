// Cue sheet shared by video.html (picture) and soundtrack.mjs (sound), so both land on the same beats.
// 96 BPM: one beat is 0.625 s and one bar is 2.5 s.
(function (root) {
  'use strict';

  const BEAT = 0.625;
  const T = {
    // 1 · the problem
    stat1: 0.625, stat2: 1.875, stat3: 3.125, stop: 3.75, note: 4.0,
    // 2 · the fix
    wizard: 5.0, glint: 5.625, beam: 5.9375, impact: 6.5625, hd: 7.5, same: 8.125, out2: 9.6,
    // 3 · title
    title: 10.0, out3: 12.2,
    // 4 · the menu it replaces
    menu: 12.5, click: 14.125, poof: 14.375, chips: 14.6, install: 15.9, out4: 17.1,
    // 5 · feed
    feed: 17.5, out5: 24.6,
    // 6 · adaptation
    adapt: 25.0, out6: 32.15,
    // 7 · good manners
    manners: 32.5, cards: [32.95, 33.25, 33.55], manifest: 34.4, out7: 37.1,
    // 8 · call to action
    cta: 37.5, ctaWord: 37.85, tagline: 38.45, pills: [39.0, 39.2], end: 45.0,
  };
  T.chipTimes = [0, 1, 2, 3].map(i => T.chips + i * (BEAT / 2));

  // Swipes between Shorts and the moment each one is corrected.
  const FEED = [
    { swipe: null, arrive: 240, fix: T.impact, best: 1080, name: 'JS tip' },
    { swipe: 18.75, arrive: 360, fix: 19.375, best: 1080, name: 'Golden hour' },
    { swipe: 20.625, arrive: 360, fix: 21.25, best: 720, name: 'Ring rain' },
    { swipe: 22.5, arrive: 480, fix: 23.125, best: 1080, name: 'Weeknight ramen' },
  ];
  const SWIPE = 0.5;

  // Adaptation chart, in seconds of playback. Two stalls drop one level; 30 s of smooth playback with
  // 15 s buffered tries 1080p again. Playback maps linearly onto video time with the drop and the
  // upgrade on bar lines.
  const CHART = { dropS: 22, upS: 54, endS: 76, stalls: [10, 19], weakS: 5, betterS: 26, strongS: 32, dropT: 27.5, upT: 30.0 };
  CHART.rate = (CHART.upS - CHART.dropS) / (CHART.upT - CHART.dropT);
  CHART.startT = CHART.dropT - CHART.dropS / CHART.rate;
  CHART.timeOf = s => CHART.startT + s / CHART.rate;

  // Voiceover, read by voiceover.mjs. Each line starts on its cue and must end before the next line
  // (or `until`). Numbers are spelled the way they should be spoken.
  const NARRATION = [
    { at: 0.55, text: 'Fast connection.' },
    { at: T.stat2, text: 'Full buffer.' },
    { at: T.stat3 - 0.1, text: 'And still, two-forty p.', until: T.wizard + 0.2 },
    { at: T.wizard + 0.3, text: 'Let’s fix that.', until: T.impact },
    { at: T.hd + 0.05, text: 'Now it’s ten-eighty p.' },
    { at: T.hd + 1.5, text: 'No reload.', until: T.title + 0.3 },
    { at: T.title + 0.35, text: 'Meet YouTube Auto HD.' },
    { at: T.menu + 0.4, text: 'No more digging through quality menus.' },
    { at: T.install, text: 'Install it once, and just watch.' },
    { at: T.feed + 0.45, text: 'It follows every Short you scroll,' },
    { at: FEED[2].swipe - 0.75, text: 'checking the real resolution, not just the label.' },
    { at: T.adapt + 0.2, text: 'Bad Wi-Fi?' },
    { at: CHART.timeOf(CHART.stalls[0]) - 0.2, text: 'If it keeps buffering, it drops one level,' },
    { at: CHART.upT - 1.0, text: 'then climbs back to HD, once playback is smooth.' },
    { at: T.cards[0] - 0.1, text: 'Your pick always wins.' },
    { at: T.manifest + 0.1, text: 'And nothing ever leaves your browser.' },
    { at: T.ctaWord + 0.15, text: 'YouTube Auto HD.' },
    { at: T.tagline + 1.1, text: 'Sit back. It’s ten-eighty p.', until: T.end - 1.6 },
  ];

  const TIMELINE = Object.freeze({ FPS: 60, DURATION: 45, BEAT, T, FEED, SWIPE, CHART, NARRATION });
  if (typeof module === 'object' && module.exports) module.exports = TIMELINE;
  else root.TIMELINE = TIMELINE;
})(this);
