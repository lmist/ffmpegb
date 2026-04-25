# ffmpegb

A command-line interface for [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) — FFmpeg running entirely in WebAssembly through Bun workers.

## What it does

`ffmpegb` lets you run FFmpeg commands from your terminal without installing a native FFmpeg binary. It loads ffmpeg.wasm from locally-vendored ESM modules and mounts direct-mode input/output paths through a Bun-backed Emscripten filesystem so large files do not have to be copied through MEMFS.

## Architecture

- **CLI (`src/cli.ts`)** — parses commands and orchestrates the workflow
- **Bun Client (`src/client.ts`)** — manages the ffmpeg.wasm runtime through Bun's Web Worker implementation
- **Worker shim (`vendor/ffmpeg/bun-worker.js`)** — fills the small browser-worker API gap Bun needs before loading the vendored ffmpeg worker
- **BUNFS (`vendor/ffmpeg/worker.js`)** — disk-backed Emscripten filesystem for direct CLI inputs and outputs, including host-backed write, rename, unlink, rmdir, symlink, and directory listing operations
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

# Print ffprobe-like metadata parsed from ffmpeg.wasm logs
bun run src/cli.ts probe <video.mp4> --json

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

Direct mode is the canonical path. The legacy `duration`, `probe`, `audio`, `frames`, and `run` commands now call the same direct planner, so local inputs and output directories are mounted through BUNFS instead of copied through MEMFS.

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

Runs the test suite, benchmark proof, stability matrix, standalone build, and an isolated smoke test that copies only the binary into `scratch/standalone/` before transcoding a fixture.

## Test suite

```bash
bun run test
```

The suite runs three end-to-end checks against a committed sample video:

1. **Duration extraction** — probes the video and prints duration in seconds
2. **Audio extraction** — writes `output.wav` (PCM) and `output.mp3` (LAME)
3. **Frame extraction** — writes 10 JPEG frames to `frames/`
4. **BUNFS operations** — verifies host-backed rename, mkdir, unlink, and rmdir behavior
5. **Direct CLI mode** — runs `ffmpegb -i input output` style commands and verifies generated files
6. **Complex direct planning** — covers `-filter_complex`, `-map`, explicit `-f`, and multi-output commands
7. **Legacy direct-mounted commands** — verifies `probe`, `audio`, and `frames` use direct-mounted IO

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
  "create-mkv-fixture": { "wallMs": 975, "outputBytes": 135021 },
  "auto-fast-mkv-to-mp4": { "wallMs": 795, "outputBytes": 145266 },
  "extract-5-jpegs": { "wallMs": 442, "outputBytes": 94847 }
}
```

Large local profile against a 1.3 GB MKV showed the BUNFS change reducing 60s transcode memory from roughly 1.41 GB RSS / 2.98 GB peak footprint to roughly 393 MB RSS / 341 MB peak footprint, with speed improving from about 0.586x to about 0.781x realtime. A 1000-frame JPEG extraction dropped from roughly 1.75 GB RSS / 2.99 GB peak footprint to roughly 347 MB RSS / 291 MB peak footprint.

## Stability matrix

```bash
bun run stability
```

The stability matrix follows the same shape as FFmpeg's FATE approach: small generated fixtures, many command invocations, and machine-readable result artifacts. It uses only this repository's Bun/ffmpeg.wasm path.

The current matrix generates MP4, MKV, WAV, and MP3 fixtures under `scratch/stability/fixtures/`, then runs 217 isolated direct-CLI cases covering:

1. **Video transcodes** — MPEG4 MP4 output across source MP4, generated MP4, and generated MKV inputs
2. **Video filters** — scale variants across multiple short durations
3. **Container remuxes** — copy-mode MKV outputs
4. **Audio extraction** — WAV and MP3 from video inputs
5. **Audio resampling** — WAV and MP3 outputs across sample rates and channel counts
6. **Frame extraction** — JPEG sequences from the committed source MP4
7. **Planner regressions** — `-filter_complex`, `-map`, `-ss`, explicit `-f`, and metadata-bearing commands

Results are written to `scratch/stability/results.json` and uploaded by CI as `stability-results`.

Console output streams the status, operation summary, and exact Bun/WASM command for each case:

```text
[001/217] PASS v1_mpeg4_source_mp4_0.25_3 254ms 31.4KB
  scratch/stability/fixtures/source.mp4 -> scratch/stability/outputs/v1_mpeg4_source_mp4_0.25_3.mp4 | t=0.25s | codec=mpeg4 | q=3 | audio=off
  $ bun run src/cli.ts -y -i scratch/stability/fixtures/source.mp4 -t 0.25 -an -c:v mpeg4 -q:v 3 -pix_fmt yuv420p scratch/stability/outputs/v1_mpeg4_source_mp4_0.25_3.mp4
```

The committed case manifest is [test/stability-matrix.json](test/stability-matrix.json), so the matrix is visible without generating scratch artifacts locally.

Recent local result:

```json
{
  "total": 217,
  "passed": 217,
  "failed": 0,
  "wallMs": 66016
}
```

## Performance boundary

Direct BUNFS IO removes the avoidable MEMFS copy cost and keeps large inputs and generated outputs on disk. Codec execution still runs inside the current ffmpeg.wasm core, which is single-threaded (`--disable-pthreads`) and CPU-bound inside WebAssembly. This tool is optimized for hermetic availability and predictable memory behavior, not native FFmpeg throughput.

## CI

GitHub Actions runs the full test suite, benchmark proof, stability matrix, and standalone binary proof on every push to `main`. It uploads `test/results.zip`, `scratch/bench/results.json`, and `scratch/stability/results.json`.

## Authors

- opennexus \<noreply@opennexus.xyz>
