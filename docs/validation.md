# Validation — 2026-09-27

## Automated checks

- 24 tests passed with Node.js 24.19.0 using the built-in test runner.
- JavaScript syntax and Git whitespace checks passed.
- Manifest parsed successfully; it declares one main-world content script on `https://www.youtube.com/*` and no additional API permissions.

The default `node` command on this Mac currently points to a Homebrew installation with a missing ICU library. Validation used the existing bundled runtime instead; no system installation was changed:

```sh
/Users/balraj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --check content.js
/Users/balraj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test tests/content.test.js
```

## Real Chrome playback checks

The repository's content script was executed in a separate YouTube test tab using Chrome's developer instrumentation. This validates the script against the real player. The unpacked extension has **not** been installed, so Chrome's installation and declarative-injection step remains a user-side smoke check.

| Check | Observed result |
| --- | --- |
| Direct control inside Shorts | Changed a test stream from 240p to 1080p using the player's quality-range method, without navigation. |
| Automatic correction while paused | Injected the script into a 240p Short paused at 70.167924 seconds. It reached 1080×1920 and kept the exact timestamp, pause state, mute state, and speed. |
| Scrolling to another Short | Script remained active across YouTube's in-page navigation. The next Short offered at most 720p, which was selected and verified at 720×1280. |
| Regular player | The same script selected and verified 1080p. |
| Manual override | Selecting 480p through YouTube's menu changed the controller to manual mode. It did not immediately force HD again. The profile's 1080p preference was restored after this test. |
| Next regular video | Clicking a related video resumed automatic control and verified 1920×1080. |
| Slow connection | Applied a 25,000-byte/s download limit (0.2 Mbps) and 100 ms latency to the test tab, then sought to an unbuffered section. Observed a temporary 720p target and decoded 1280×720 playback. |
| Recovery | Removed throttling and restored normal caching. The script returned to 1080p, verified at 1920×1080. |
| Original blurry section | Final source verified the original Short at 137 seconds: 1080×1920, matching optimal resolution, with zero dropped frames in that test session. |
| Extension diagnostics | No extension warnings or errors were captured during the final successful playback check. |

Throttling and cache overrides were removed. Test tabs were closed after verification; developer-injected scripts were not left running in the user's original YouTube tabs.

## Scope of confidence

The original regression, standard-player behavior, manual override, in-page navigation, and one throttle/recovery scenario were exercised live. Automated tests cover additional boundaries such as backgrounding, unavailable observations, stale players, retry exhaustion, short-clip recovery, and Premium filtering.

This is not a broad benchmark across codecs, all networks, ad variants, or YouTube experiments. The quality-control integration is undocumented and may require maintenance when YouTube changes its player.
