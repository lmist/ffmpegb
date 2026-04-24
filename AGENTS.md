# Project Rules

## ffmpeg Constraint

Never use a locally installed `ffmpeg`, `ffprobe`, or related native FFmpeg binary to implement, test, benchmark, or generate outputs for this project.

All media processing work must go through this repository's Bun/ffmpeg.wasm toolchain. If the wasm tool cannot do something, fix the tool or report the limitation; do not fall back to native FFmpeg.

## Scratch Data

Use `scratch/` for large local media, profiling logs, and generated outputs. It is ignored by git and must stay out of commits.
