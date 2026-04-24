# ffmpegb

A command-line interface for [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) — FFmpeg running entirely in WebAssembly through Bun workers.

## What it does

`ffmpegb` lets you run FFmpeg commands from your terminal without installing a native FFmpeg binary. It loads ffmpeg.wasm from locally-vendored ESM modules and mounts direct-mode input/output paths through a Bun-backed Emscripten filesystem so large files do not have to be copied through MEMFS.

## Architecture

- **CLI (`src/cli.ts`)** — parses commands and orchestrates the workflow
- **Bun Client (`src/client.ts`)** — manages the ffmpeg.wasm runtime through Bun's Web Worker implementation
- **Worker shim (`vendor/ffmpeg/bun-worker.js`)** — fills the small browser-worker API gap Bun needs before loading the vendored ffmpeg worker
- **BUNFS (`vendor/ffmpeg/worker.js`)** — disk-backed Emscripten filesystem for direct CLI inputs and outputs
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
bun run src/cli.ts -i <video.mkv> <output.mp4>

# Get video duration
bun run src/cli.ts duration <video.mp4>

# Extract audio as WAV and MP3
bun run src/cli.ts audio <video.mp4>

# Extract frames (default 10)
bun run src/cli.ts frames <video.mp4> --count=10

# Legacy arbitrary ffmpeg command
bun run src/cli.ts run <video.mp4> -- -vf scale=320:240 output.mp4
```

Direct `.mkv -> .mp4` commands with no explicit codec/filter options use the fast WASM profile:

```bash
-c:v mpeg4 -q:v 5 -pix_fmt yuv420p -c:a aac -b:a 160k -sn
```

Pass explicit codec, bitrate, map, preset, or filter options to override it.

## Build standalone binary

```bash
make build
# or
bun run build
```

Produces a single `ffmpegb` executable. The compiled binary embeds the vendored ffmpeg.wasm runtime and does not require a sibling `vendor/` directory at runtime.

```bash
make verify
```

Runs the test suite, benchmark proof, standalone build, and an isolated smoke test that copies only the binary into `scratch/standalone/` before transcoding a fixture.

## Test suite

```bash
bun run test
```

The suite runs three end-to-end checks against a committed sample video:

1. **Duration extraction** — probes the video and prints duration in seconds
2. **Audio extraction** — writes `output.wav` (PCM) and `output.mp3` (LAME)
3. **Frame extraction** — writes 10 JPEG frames to `frames/`
4. **Direct CLI mode** — runs `ffmpegb -i input output` style commands and verifies generated files

On success, result assets are zipped into `test/results.zip`.

## Benchmark proof

```bash
bun run bench
```

The benchmark uses only this tool's Bun/ffmpeg.wasm path. It creates a tiny MKV fixture under `scratch/bench/` from the committed sample MP4, then measures:

1. **Fixture generation** — MP4 to MKV using the WASM CLI
2. **Auto-fast transcode** — MKV to MP4 using the default fast WASM profile
3. **JPEG extraction** — direct CLI extraction to a host-mounted frame directory

Results are written to `scratch/bench/results.json` and uploaded by CI as `benchmark-results`.

Recent local benchmark on an Apple Silicon Mac:

```json
{
  "create-mkv-fixture": { "wallMs": 881, "outputBytes": 135021 },
  "auto-fast-mkv-to-mp4": { "wallMs": 696, "outputBytes": 145266 },
  "extract-5-jpegs": { "wallMs": 486, "outputBytes": 94847 }
}
```

Large local profile against a 1.3 GB MKV showed the BUNFS change reducing 60s transcode memory from roughly 1.41 GB RSS / 2.98 GB peak footprint to roughly 393 MB RSS / 341 MB peak footprint, with speed improving from about 0.586x to about 0.781x realtime. A 1000-frame JPEG extraction dropped from roughly 1.75 GB RSS / 2.99 GB peak footprint to roughly 347 MB RSS / 291 MB peak footprint.

## CI

GitHub Actions runs the full test suite and benchmark proof on every push to `main`. The workflow installs Bun, runs the tests, uploads `test/results.zip`, runs `bun run bench`, and uploads `scratch/bench/results.json`.

## Authors

- opennexus \<noreply@opennexus.xyz>
