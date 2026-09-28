# YouTube Auto HD — minimal v1 specification

Status: v1 implementation baseline. The user authorized building in this repository after reviewing the draft. Browser installation remains a separate step.

## Objective

Automatically prefer 1080p on YouTube Shorts without a button, while allowing lower quality when playback cannot sustain HD. Recover toward 1080p when conditions improve.

The motivating issue was reproduced on desktop Chrome: a Short played at 240×426 despite a reported connection speed of approximately 45 Mbps and a 36-second buffer. Selecting 1080p in the regular player and reloading the Short restored 1080×1920 playback. The reason YouTube's Auto mode selected 240p remains unknown.

## Scope and defaults

Confirmed requirements:

- Runs automatically; no per-video action.
- 1080p is the default preferred quality.
- Adapts to connection conditions instead of forcing unusable HD playback.
- Applies only to YouTube Shorts on `https://www.youtube.com/shorts/`. Regular watch pages are left to YouTube.

Proposed v1 scope:

- Desktop Chrome, using Manifest V3.
- 1080p is the automatic ceiling. If unavailable, choose the highest available standard quality below it.
- No popup, toolbar action, account, server, or settings screen. The browser's extension toggle provides the on/off control.
- Network adaptation uses buffer health and actual playback interruptions. Direct Mbps estimation and external speed tests are deferred.
- Live streams, embedded players, other browsers, and Premium-only quality variants are outside v1.

## Automatic behavior

### Start and video changes

1. Detect the active video on initial page load and YouTube navigation, including scrolling between Shorts.
2. Wait until that video's quality choices are available.
3. Request 1080p, or the highest eligible quality below it, unless a temporary lower target is already active from recent buffering in this tab.
4. Check the decoded video's dimensions to verify the result. A quality request alone is not proof of success. For this vertical Short, 1080p is 1080×1920; orientation must be accounted for.
5. If YouTube later selects a lower quality while playback is healthy, restore the current target. Do not overwrite a lower target that the extension deliberately selected after buffering.

### Respond to a weak connection

Use the contiguous buffered range containing the playback position to calculate buffered time ahead. Account for playback speed. Observe interruptions while the video is supposed to be playing.

Initial tuning values, subject to real playback testing:

| Condition | Action |
| --- | --- |
| Smooth playback with adequate buffer | Keep the current target; prefer 1080p when no fallback is active. |
| Two qualifying interruptions within 30 seconds of active playback, or one continuing interruption lasting 8 seconds | Lower the target by one available quality level. |
| 30 seconds of uninterrupted active playback and at least 15 seconds buffered ahead | Try one level higher, up to 1080p. |
| An upgrade causes qualifying buffering again | Step back down and wait at least 60 seconds before another upgrade attempt. |

A qualifying interruption lasts at least 2 seconds and has less than 2 seconds buffered ahead. Exclude startup, seeking, the first 5 seconds after a video change or seek, advertisements, paused or ended playback, and hidden tabs. Reset interruption counting after a downgrade, and allow at least 8 seconds for the lower quality to take effect before another downgrade. A brief fluctuation or a single dropped frame does not cause a downgrade.

Retain the temporary target across videos in the same tab to avoid retrying HD on every Short over a struggling connection. Stable-playback time may accumulate across Shorts, excluding their startup and seek grace periods. A page reload starts a fresh session. If the remaining video is already buffered, do not lower quality because downloads have stopped. Recovery rules must still permit testing higher quality on a subsequent video.

These values are product defaults to validate, not universal bandwidth thresholds. A healthy buffer at 720p does not prove that 1080p is sustainable; an upgrade is a bounded trial.

### Preserve the viewing experience

- Keep the same page, video, playback position, pause state, speed, and audio settings.
- Do not open tabs, navigate to the regular player, reload pages, or restart playback to change quality.
- Act only on the active player, not preloaded Shorts or advertisements.
- Proposed manual override: a user-selected quality takes precedence for the current video. Resume automatic selection on the next video.
- If playback signals are missing, do not infer a slow connection. Leave YouTube in control until reliable signals return.
- If quality control stops working, stop retrying after three attempts for that video and leave YouTube in control. Emit one local diagnostic message rather than repeatedly interrupting playback.

## Technical approach and limits

Use a small, dependency-free JavaScript content script, restricted to YouTube. It loads on every YouTube page because YouTube navigates in-page, and acts only while a Shorts URL is active. It observes video changes and playback health, keeps temporary state in memory, and requests the target quality through the page's player.

YouTube's public iframe API does not support setting playback quality. Inspection of the current Shorts player exposed internal quality methods, including `setPlaybackQualityRange`, but their presence does not establish that automatic control works. The first implementation validation must prove that the current player accepts a quality change without navigation or reloading. Do not substitute a disruptive workaround if that fails; report the compatibility limitation and revisit this spec.

Proposed extension footprint: one manifest and one content script running in the page's main JavaScript world. No background service worker, remote code, cookies API, browsing-history access, analytics, or external network requests. The script must treat page-provided data as untrusted.

## Acceptance criteria

1. **Automatic HD:** On a supported video with 1080p available and adequate connectivity, request 1080p within 2 seconds of quality choices becoming available. Verify HD delivery during active playback without a click.
2. **Original regression:** The vLLM Short remains HD through the previously blurry section at approximately 2:17 on a healthy connection.
3. **Navigation:** Moving to another Short reapplies the appropriate target without accumulating listeners or timers. Navigating to a regular video leaves its player untouched.
4. **Unavailable HD:** A video limited to 720p stays at 720p without repeated failed requests for 1080p.
5. **Network adaptation:** Repeated qualifying buffering lowers quality one step. Sustained recovery triggers an upgrade trial. Repeated failed trials obey the backoff.
6. **No false downgrades:** Seeking, pausing, switching Shorts, backgrounding the tab, and reaching the end do not count as network failures.
7. **No quality oscillation:** Temporary fallback is respected; the HD preference does not immediately undo a deliberate downgrade.
8. **Manual choice:** Selecting a quality manually suspends automation for that video.
9. **Compatibility failure:** Missing or ineffective player methods stop bounded retries without changing the page or disrupting playback.
10. **Preservation:** Every quality change preserves position, pause state, playback speed, and audio settings.

## Development conventions

Proposed project structure, to be created only during implementation:

```text
youtube-auto-hd/
  manifest.json          Extension metadata and YouTube-only scope
  content.js             Player integration and quality policy
  tests/content.test.js  Deterministic policy and lifecycle tests
  README.md              Installation, behavior, limitations, removal
```

Use plain JavaScript, two-space indentation, descriptive `camelCase` names, named constants for tuning values, and short functions. Keep the quality policy separable from YouTube-specific access so it can be tested with supplied playback observations. Style example only:

```js
const preferredHeight = 1080;
const upgradeCooldownMs = 60_000;
```

Proposed validation commands, run from the future extension directory:

```sh
node --check content.js
node --test tests/content.test.js
```

No compilation or dependency installation is required. Load the source directory as an unpacked extension for integration testing after implementation and user-authorized installation.

## Testing and boundaries

Use Node's built-in test runner for quality choice, interruption windows, seek/startup exclusions, fallback persistence, upgrade backoff, and bounded retries. Use a real Chrome session to verify Shorts, that regular videos are left untouched, manual override, quality changes, and playback preservation. Controlled network throttling belongs in an isolated test session. Synthetic policy tests alone are insufficient.

- Always: verify delivered quality, keep retries bounded, preserve playback, and report what was actually tested.
- Discuss before expanding scope: additional permissions, dependencies, other browsers, a settings UI, or network-speed measurement.
- Never: collect viewing history, send telemetry, inject remote code, interfere with ads or access restrictions, or install/publish the extension as part of specification work.

The adaptive thresholds and manual-override behavior are proposed details for review. Reliable direct quality control remains the main technical question to validate during implementation.

## References

- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [YouTube player API and quality-control deprecation](https://developers.google.com/youtube/iframe_api_reference)
- [Buffered media ranges](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/buffered)
- [Playback waiting events](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/waiting_event)
- [YouTube's approximate sustained-speed guidance](https://support.google.com/youtube/answer/3037019?hl=en)
