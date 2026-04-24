# ffmpegb

A command-line interface for [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) — FFmpeg running entirely in WebAssembly through Bun workers.

## What it does

`ffmpegb` lets you run FFmpeg commands from your terminal without installing a native FFmpeg binary. It loads ffmpeg.wasm from locally-vendored ESM modules and proxies file I/O between your local disk and ffmpeg.wasm's virtual filesystem.

## Architecture

- **CLI (`src/cli.ts`)** — parses commands and orchestrates the workflow
- **Bun Client (`src/client.ts`)** — manages the ffmpeg.wasm runtime through Bun's Web Worker implementation
- **Worker shim (`vendor/ffmpeg/bun-worker.js`)** — fills the small browser-worker API gap Bun needs before loading the vendored ffmpeg worker
- **Vendor files (`vendor/`)** — local copies of `@ffmpeg/ffmpeg`, `@ffmpeg/util`, and `@ffmpeg/core` so the tool works offline and avoids CDN dependencies

## Install

```bash
bun install
```

No Playwright or Chromium install is required.

## Usage

```bash
# Run ffmpeg-style commands directly
bun run src/cli.ts -i <video.mp4> <output.wav>
bun run src/cli.ts -i <video.mp4> -vf scale=320:240 <output.mp4>

# Get video duration
bun run src/cli.ts duration <video.mp4>

# Extract audio as WAV and MP3
bun run src/cli.ts audio <video.mp4>

# Extract frames (default 10)
bun run src/cli.ts frames <video.mp4> --count=10

# Legacy arbitrary ffmpeg command
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
4. **Direct CLI mode** — runs `ffmpegb -i input output` style commands and verifies generated files

On success, result assets are zipped into `test/results.zip`.

## CI

GitHub Actions runs the full test suite on every push to `main`. The workflow installs Bun, runs the tests, and uploads `test/results.zip` as a build artifact.

## Authors

- opennexus \<noreply@opennexus.xyz>
