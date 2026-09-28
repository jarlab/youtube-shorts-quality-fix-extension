# YouTube Auto HD

A small Chrome extension that automatically prefers **1080p** on YouTube Shorts. Regular videos are left to YouTube. No button, popup, account, or build step.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository directory:
   `/Users/balraj/Desktop/balraj/youtube-shorts-quality-fix-extension`
4. Reload your existing YouTube tabs once. New YouTube tabs work automatically.

Requires Chrome 111 or newer. Chrome will request access to pages on `www.youtube.com`. The extension has no access to other sites and does not run in embedded players.

To update it after editing the source, click **Reload** on the extension's card and reload your YouTube tabs. To turn it off, disable/remove it in Chrome and reload the open YouTube tabs; a script already running in a page lasts until that page reloads.

## Behavior

- Prefers standard 1080p; chooses the highest available lower resolution if HD is unavailable.
- Works in the current player without opening tabs, reloading, seeking, changing playback speed, or changing audio settings.
- Acts only on Shorts (`/shorts/…`). It loads on every YouTube page so it can follow in-page navigation, including scrolling between Shorts, but sends no quality requests on regular `/watch` pages.
- Drops one available quality level after two sustained buffering interruptions or one long interruption.
- Tries a higher level after stable playback and a healthy buffer; backs off for 60 seconds after a failed upgrade.
- Keeps a temporary lower target across videos in the same tab so it does not immediately undo its own fallback.
- Respects a manually chosen quality for the current video. Automatic behavior resumes on the next video.
- Ignores ads, hidden tabs, live streams, startup, and seeking when assessing network problems.

Network adaptation uses **actual playback and buffered video**, not a separate speed test. A fast connection keeps the preferred HD target. There is no 4K mode or settings UI in this version.

## Verify it

Right-click a playing video and select **Stats for nerds**. Check **Current / Optimal Res**. For a vertical Short, 1080p commonly reads `1080x1920`.

The extension checks the decoded video dimensions as well as the player's quality label. It gives up after three unverified quality requests for a video instead of retrying indefinitely. A local console warning explains when YouTube's player controls could not be used.

## Limitations

YouTube does not provide a supported public API for forcing quality. This extension uses the current website's internal `setPlaybackQualityRange` method. YouTube can change it, in which case the integration may need updating. Quality transitions can briefly buffer, especially on a weak connection.

Only desktop Chrome, standard video qualities, and Shorts on YouTube's main website are covered. No regular videos, Premium-only options, live streams, embedded players, or other browsers are supported in v1. Adaptive thresholds are initial tuning values, not universal bandwidth guarantees.

## Privacy

Everything runs locally in the YouTube page. No analytics, external requests, cookies API, history API, saved viewing history, server, or remote code. The manifest declares one YouTube-only content script and no additional API permissions.

## Development

There are no dependencies to install. From this directory, using Node.js 22 or newer:

```sh
node --check content.js
node --test tests/content.test.js
```

The tests cover selection, fallback, recovery, exclusions, retries, manual override, and player lifecycle using deterministic playback observations. Real-player validation is recorded in [docs/validation.md](docs/validation.md).

- [Specification](docs/spec.md)
- `content.js`: quality policy, verification, and YouTube integration
- `manifest.json`: extension metadata and site scope

Installing the extension is a separate step from building and testing its source.
