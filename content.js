(() => {
  'use strict';

  const HEIGHTS = Object.freeze({ hd1080: 1080, hd720: 720, large: 480, medium: 360, small: 240, tiny: 144 });
  const DEFAULTS = Object.freeze({
    settlingMs: 5000,
    interruptionMs: 2000,
    longStallMs: 8000,
    interruptionWindowMs: 30_000,
    recoveryMs: 30_000,
    downgradeGraceMs: 8000,
    retryUpgradeMs: 60_000,
    verificationMs: 8000,
    maxAttempts: 3,
  });

  function standardLevels(choices) {
    if (!Array.isArray(choices)) return [];
    const eligible = choices.filter(choice => typeof choice === 'string' || (
      choice && choice.isPlayable === true && !choice.paygatedQualityDetails &&
      !/premium/i.test(choice.qualityLabel || '')
    )).map(choice => typeof choice === 'string' ? choice : choice.quality);
    return [...new Set(eligible)].filter(quality => Object.hasOwn(HEIGHTS, quality))
      .sort((a, b) => HEIGHTS[b] - HEIGHTS[a]);
  }

  function bufferAhead(ranges, time, rate) {
    if (!ranges || !Number.isFinite(time) || !(rate > 0)) return null;
    try {
      for (let i = 0; i < ranges.length; i++) {
        if (ranges.start(i) <= time + 0.05 && ranges.end(i) >= time) {
          return (ranges.end(i) - time) / rate;
        }
      }
      return 0;
    } catch {
      return null;
    }
  }

  function deliveredQualityMatches(target, reported, width, height) {
    if (target !== reported || !(width > 0 && height > 0)) return false;
    // Account for portrait and wide-aspect encodes, including 1920x800 at 1080p.
    const nominalHeight = Math.max(Math.min(width, height), Math.max(width, height) * 9 / 16);
    return nominalHeight >= HEIGHTS[target] * 0.9;
  }

  class QualityPolicy {
    constructor() {
      this.height = 1080;
      this.videoId = null;
      this.lastNow = null;
      this.activeMs = 0;
      this.stableMs = 0;
      this.interruptions = [];
      this.stallMs = 0;
      this.stallCounted = false;
      this.graceUntil = 0;
      this.upgradeAfter = 0;
      this.upgradeTrial = false;
      this.manual = false;
    }

    manualOverride() {
      this.manual = true;
      this.clearStall();
    }

    clearStall() {
      this.stallMs = 0;
      this.stallCounted = false;
    }

    seek(now) {
      this.graceUntil = now + DEFAULTS.settlingMs;
      this.stableMs = 0;
      this.interruptions = [];
      this.clearStall();
    }

    observe(sample) {
      const { now, videoId, active, seeking, stalled, buffer, fullyBuffered = false } = sample;
      const levels = standardLevels(sample.levels);
      const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(1000, now - this.lastNow));
      this.lastNow = now;
      if (videoId !== this.videoId) {
        this.videoId = videoId;
        this.manual = false;
        this.interruptions = [];
        this.clearStall();
        this.graceUntil = now + DEFAULTS.settlingMs;
      }
      const target = () => levels.find(level => HEIGHTS[level] <= this.height) || levels.at(-1) || null;
      const result = reason => ({ quality: this.manual ? null : target(), reason, height: this.height });
      if (!videoId || !levels.length) return { quality: null, reason: 'unavailable', height: this.height };
      if (seeking) this.seek(now);
      if (!Number.isFinite(buffer)) {
        this.clearStall();
        return { quality: null, reason: 'unavailable', height: this.height };
      }
      if (!active || seeking || this.manual || now < this.graceUntil) {
        this.clearStall();
        return result(this.manual ? 'manual' : 'settling');
      }

      this.activeMs += dt;
      this.interruptions = this.interruptions.filter(at => this.activeMs - at <= DEFAULTS.interruptionWindowMs);
      if (stalled && buffer < 2 && !fullyBuffered) {
        this.stableMs = 0;
        this.stallMs += dt;
        if (this.stallMs >= DEFAULTS.interruptionMs && !this.stallCounted) {
          this.interruptions.push(this.activeMs);
          this.stallCounted = true;
        }
        if (this.interruptions.length >= 2 || this.stallMs >= DEFAULTS.longStallMs) {
          const lower = levels[levels.indexOf(target()) + 1];
          if (lower) {
            this.height = HEIGHTS[lower];
            if (this.upgradeTrial) this.upgradeAfter = now + DEFAULTS.retryUpgradeMs;
            this.upgradeTrial = false;
            this.graceUntil = now + DEFAULTS.downgradeGraceMs;
            this.interruptions = [];
            this.clearStall();
            return result('fallback');
          }
        }
      } else {
        this.clearStall();
        if (!stalled) this.stableMs += dt;
        if (this.stableMs >= DEFAULTS.recoveryMs && (buffer >= 15 || fullyBuffered) && now >= this.upgradeAfter) {
          const higher = levels[levels.indexOf(target()) - 1];
          if (higher) {
            this.height = HEIGHTS[higher];
            this.stableMs = 0;
            this.interruptions = [];
            this.upgradeTrial = true;
            return result('recovery');
          }
        }
      }
      return result(this.height < 1080 ? 'fallback' : 'preferred');
    }
  }

  class QualityRequests {
    constructor() {
      this.target = null;
      this.attempts = 0;
      this.pendingMs = 0;
      this.lastNow = null;
      this.lastRequest = -Infinity;
      this.stopped = false;
    }

    next({ target, reported, width, height, now, playing }) {
      const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(1000, now - this.lastNow));
      this.lastNow = now;
      if (this.stopped || !target) return false;
      if (target !== this.target) {
        this.target = target;
        this.pendingMs = 0;
      } else if (deliveredQualityMatches(target, reported, width, height)) {
        this.attempts = 0;
        this.pendingMs = 0;
        return false;
      } else {
        if (playing) this.pendingMs += dt;
        if (this.attempts > 0 && this.pendingMs < DEFAULTS.verificationMs) return false;
        if (now - this.lastRequest < DEFAULTS.verificationMs) return false;
      }
      if (this.attempts >= DEFAULTS.maxAttempts) {
        this.stopped = true;
        return false;
      }
      this.attempts++;
      this.pendingMs = 0;
      this.lastRequest = now;
      return true;
    }
  }

  function install(page) {
    const key = Symbol.for('youtube-auto-hd/v1');
    if (page[key]) return page[key];
    const doc = page.document;
    const policy = new QualityPolicy();
    let context = null;
    let requests = new QualityRequests();
    let warned = false;
    let released = false;
    let seekUntil = 0;
    let status = { state: 'waiting' };

    function readContext() {
      const url = new URL(page.location.href);
      // The script loads on all of YouTube to follow in-page navigation, but acts only on Shorts.
      const videoId = url.pathname.match(/^\/shorts\/([\w-]+)\/?$/)?.[1];
      if (!videoId) return null;
      const player = doc.getElementById('shorts-player');
      if (!player || typeof player.getVideoData !== 'function') return null;
      const data = player.getVideoData();
      if (data?.video_id !== videoId || data.isLive || data.isLiveContent || data.isUpcoming) return null;
      const video = player.querySelector('video');
      if (!video) return null;
      const choices = typeof player.getAvailableQualityData === 'function'
        ? player.getAvailableQualityData() : player.getAvailableQualityLevels?.();
      return { player, video, videoId, levels: standardLevels(choices) };
    }

    function tick() {
      if (doc.visibilityState !== 'visible') {
        policy.clearStall();
        policy.lastNow = page.performance.now();
        requests.lastNow = policy.lastNow;
        return;
      }
      try {
        const next = readContext();
        if (!next) {
          status = { state: 'waiting' };
          return;
        }
        if (!context || context.videoId !== next.videoId || context.video !== next.video || context.player !== next.player) {
          requests = new QualityRequests();
          warned = false;
          released = false;
          seekUntil = 0;
        }
        context = next;
        const { player, video, videoId, levels } = context;
        const now = page.performance.now();
        const ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
        const buffer = bufferAhead(video.buffered, video.currentTime, video.playbackRate);
        const remaining = (video.duration - video.currentTime) / video.playbackRate;
        const active = !ad && !video.paused && !video.ended;
        const fullyBuffered = Number.isFinite(remaining) && remaining > 0 && buffer !== null && buffer >= remaining - 0.25;
        const choice = policy.observe({
          now, videoId, levels, active, seeking: video.seeking,
          stalled: video.readyState < 3, buffer, fullyBuffered,
        });
        const reported = player.getPlaybackQuality?.();
        status = {
          state: requests.stopped ? 'unsupported' : ad ? 'ad' : choice.reason,
          videoId, target: choice.quality, current: reported,
          width: video.videoWidth, height: video.videoHeight,
          verified: deliveredQualityMatches(choice.quality, reported, video.videoWidth, video.videoHeight),
          attempts: requests.attempts,
        };
        if (ad || !choice.quality || video.seeking) return;
        const shouldRequest = requests.next({
          target: choice.quality, reported, width: video.videoWidth, height: video.videoHeight,
          now, playing: active && now >= seekUntil,
        });
        if (shouldRequest) {
          // Internal YouTube API; bounded verification makes failures harmless.
          if (typeof player.setPlaybackQualityRange !== 'function') throw new Error('Quality control is unavailable');
          player.setPlaybackQualityRange(choice.quality, choice.quality);
        }
        if (requests.stopped && !released) {
          released = true;
          // Remove a possibly applied quality lock before yielding to YouTube.
          player.setPlaybackQualityRange?.('auto', 'auto');
          if (!warned) {
            warned = true;
            page.console.warn('[YouTube Auto HD] Quality control could not be verified. Automation stopped for this video.');
          }
        }
      } catch {
        if (!warned) {
          warned = true;
          page.console.warn('[YouTube Auto HD] Player controls are unavailable or changed. Leaving playback untouched.');
        }
      }
    }

    function onSeek(event) {
      if (event.target !== context?.video) return;
      const now = page.performance.now();
      policy.seek(now);
      seekUntil = now + DEFAULTS.settlingMs;
    }

    function onManualQuality(event) {
      if (!event.isTrusted || (event.type === 'keydown' && !['Enter', ' '].includes(event.key))) return;
      const item = event.target.closest?.('.ytp-quality-menu .ytp-menuitem');
      if (item && context?.player.contains(item)) {
        policy.manualOverride();
        tick();
      }
    }

    const timer = page.setInterval(tick, 500);
    doc.addEventListener('seeking', onSeek, true);
    doc.addEventListener('click', onManualQuality, true);
    doc.addEventListener('keydown', onManualQuality, true);
    doc.addEventListener('yt-navigate-finish', tick);
    doc.addEventListener('visibilitychange', tick);
    const controller = {
      status: () => ({ ...status }),
      destroy() {
        page.clearInterval(timer);
        doc.removeEventListener('seeking', onSeek, true);
        doc.removeEventListener('click', onManualQuality, true);
        doc.removeEventListener('keydown', onManualQuality, true);
        doc.removeEventListener('yt-navigate-finish', tick);
        doc.removeEventListener('visibilitychange', tick);
        delete page[key];
      },
    };
    page[key] = controller;
    tick();
    return controller;
  }

  if (typeof window === 'undefined' && typeof module !== 'undefined') {
    module.exports = { QualityPolicy, QualityRequests, standardLevels, bufferAhead, deliveredQualityMatches, install };
  } else if (typeof window !== 'undefined' && window.top === window) {
    install(window);
  }
})();
