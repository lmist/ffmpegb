# ffmpegb

A command-line interface for [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) — FFmpeg running entirely in WebAssembly inside a headless browser. Built with [Bun](https://bun.sh) and [Playwright](https://playwright.dev/).

## What it does

`ffmpegb` lets you run FFmpeg commands from your terminal without installing a native FFmpeg binary. It launches a headless Chromium browser, loads ffmpeg.wasm from locally-vendored ESM modules, and proxies file I/O between your local disk and the browser's virtual filesystem.

## Architecture

- **CLI (`src/cli.ts`)** — parses commands and orchestrates the workflow
- **Browser Client (`src/client.ts`)** — manages a Playwright headless browser instance and a local Bun HTTP server that serves the ffmpeg.wasm vendor files
- **Browser API (`src/browser-api.ts`)** — the HTML/JS module that runs inside the browser, loading ffmpeg.wasm and exposing `window.__ffmpegb`
- **Vendor files (`vendor/`)** — local copies of `@ffmpeg/ffmpeg`, `@ffmpeg/util`, and `@ffmpeg/core` so the tool works offline and avoids CDN dependencies

## Install

```bash
bun install
```

Playwright Chromium browser is required at runtime and will be downloaded automatically on first use, or you can pre-install it:

```bash
npx playwright install chromium
```

## Usage

```bash
# Get video duration
bun run src/cli.ts duration <video.mp4>

# Extract audio as WAV and MP3
bun run src/cli.ts audio <video.mp4>

# Extract frames (default 10)
bun run src/cli.ts frames <video.mp4> --count=10

# Run arbitrary ffmpeg command
bun run src/cli.ts run <video.mp4> -- -vf scale=320:240 output.mp4
```

## Build standalone binary

```bash
bun run build
```

Produces a single `ffmpegb` executable.

## Test suite

```bash
bun test
```

The suite runs three end-to-end checks against a committed sample video:

1. **Duration extraction** — probes the video and prints duration in seconds
2. **Audio extraction** — writes `output.wav` (PCM) and `output.mp3` (LAME)
3. **Frame extraction** — writes 10 JPEG frames to `frames/`

On success, result assets are zipped into `test/results.zip`.

## CI

GitHub Actions runs the full test suite on every push to `main`. The workflow installs Bun, Playwright Chromium, runs the tests, and uploads `test/results.zip` as a build artifact.

## Authors

- opennexus \<noreply@opennexus.xyz>
