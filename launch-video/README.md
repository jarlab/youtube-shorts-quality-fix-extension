# Launch video

A 45-second launch video for YouTube Auto HD, generated entirely from code: 1920×1080 at 60 fps, H.264 with an AAC soundtrack, plus a 720p cut small enough to embed on GitHub.

The picture is an HTML page rendered frame by frame in headless Chrome. The music and sound effects are synthesised in Node. The voiceover is read by Kokoro, an open-weight neural text-to-speech model that runs locally. There is no stock footage, sample library, or ffmpeg.

## Storyboard

| Time | Scene | Beat |
| --- | --- | --- |
| 0:00 | The problem | A fast connection and 36 s of buffer, yet the Short plays at 240p. These are the numbers from the original bug report in [`docs/spec.md`](../docs/spec.md). The music plays muffled, then stops like a record. |
| 0:05 | The fix | The wizard zaps the Short to 1080p in place ("same Short, same second, no reload"). The music opens up and the drums drop in. |
| 0:10 | Title | YouTube Auto HD: automatic 1080p for Shorts and videos. |
| 0:12.5 | No chores | The quality menu disappears. No button, popup, settings, or account. |
| 0:17.5 | Feed | Scrolling four Shorts. Each is corrected and verified by its decoded resolution, including one where 720p is the best available. |
| 0:25 | Adapts | Two stalls drop one level. 30 s of smooth playback with 15 s buffered tries 1080p again. A failed upgrade waits 60 s. |
| 0:32.5 | Good manners | Manual choices win, only real stalls count, nothing leaves the browser. |
| 0:37.5 | Call to action | Wizard, name, "Sit back. It's 1080p.", Chrome 111+, and the GitHub URL. |

Every claim matches the behavior described in the main [README](../README.md) and [specification](../docs/spec.md). The Shorts are illustrated stand-ins drawn on a canvas. Their low resolution is simulated relative to the on-screen player: each frame is downscaled, JPEG-compressed, and scaled back up. The player chrome is generic, not YouTube's interface.

## Voiceover

A calm female narrator reads 18 short lines, from "Fast connection. Full buffer. And still, two-forty p." to "Sit back. It's ten-eighty p." The script is `NARRATION` in `timeline.js`. Each line starts on a cue and must finish before the next one. Numbers are spelled the way they should be spoken.

The voice is `af_heart` from [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache 2.0), the model's top-rated voice, read slightly slower than normal. `voiceover.mjs` reads any line that would overrun its slot a little faster. `soundtrack.mjs` mixes the lines in and dips the music by about 7 dB and the effects by about 6 dB while she speaks.

To try another voice, `node voiceover.mjs --samples` reads one passage in `af_heart`, `af_bella`, `af_nicole` (softer, breathier), and `bf_emma` (British) into `out/voice-samples/`. Then run `node voiceover.mjs --voice af_bella` and remix. `--check` transcribes every generated line with Whisper, to confirm the words and pronunciation.

## Preview

Open `video.html` in Chrome. It fits the stage to the window and has a scrubber. Space plays and pauses, arrow keys step one frame, and Shift+arrow steps one second. Append `?t=12.5` to open at a given time. After `node soundtrack.mjs` has run, playback includes the soundtrack.

## Render

Requires macOS, Google Chrome, Node.js 22 or newer, and the Xcode command-line tools (`swiftc`). From this directory:

```sh
npm install
node voiceover.mjs
node soundtrack.mjs
node render.mjs
```

`npm install` fetches `kokoro-js`, which only the voiceover needs. On first use it downloads the Kokoro model from Hugging Face (about 330 MB, cached in `node_modules`). Without `out/voice/`, `soundtrack.mjs` mixes the music on its own.

After changing only the sound, `node render.mjs --mux` puts the new `out/soundtrack.wav` into the existing renders in a few seconds, without re-rendering frames.

This writes three files:

- `out/launch.mp4`: the 1080p, 60 fps master.
- `out/launch-720p.mp4`: a 720p, 30 fps cut under GitHub's 10 MB upload limit.
- `out/poster.png`: a poster frame from the call to action.

A full render takes about four minutes on an Apple M3 Pro. `render.mjs` compiles `encode.swift` on first use, and `--workers` sets how many Chrome windows render frames in parallel.

For review, `node render.mjs --stills 3.5,7.5` writes PNG frames to `out/stills/`, and `--from 17 --to 25` renders part of the timeline without sound.

Fonts come from Google Fonts (Bricolage Grotesque, Inter, JetBrains Mono, Caveat). The first render needs network access; later renders use the cache in `out/.chrome-cache`.

## Files

- `timeline.js`: cue sheet shared by picture and sound, including the narration script. Change timings here.
- `voiceover.mjs`: reads the narration with Kokoro into `out/voice/`.
- `video.html`: the composition. Every frame is a pure function of time, so frames render in any order. Copy lives in the `data-words` attributes.
- `soundtrack.mjs`: a lo-fi groove (I–vi–IV–V in F, 96 BPM) and sound effects on the same cues, with the voiceover mixed on top. Its filter tracks the picture's quality: muffled at 240p, open at 1080p, dipping when a Short arrives in low resolution or the Wi-Fi weakens.
- `render.mjs`: drives headless Chrome over the DevTools protocol and streams frames to the encoder.
- `encode.swift`: AVFoundation H.264 encoder, audio muxer, and frame extractor (`encode still <video> <seconds> <out.png>`).

The encoder tags video with the sRGB transfer function, so color-managed players such as QuickTime and Safari show the same colors as the browser.
