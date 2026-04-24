import { FfmpegClient } from "../src/client.js";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const VIDEO = resolve(import.meta.dirname, "test_video.mp4");

function extractDuration(logs: Array<{ type: string; message: string }>): number | null {
  const text = logs.map((l) => l.message).join("\n");
  const match = text.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
  if (match) {
    const hours = parseFloat(match[1]);
    const minutes = parseFloat(match[2]);
    const seconds = parseFloat(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

const client = new FfmpegClient();
await client.launch();

let failed = 0;

// Test 1: Duration
{
  console.log("=== TEST 1: Duration ===");
  await client.writeFile("input", VIDEO);
  const result = await client.exec("-i", "input");
  const duration = extractDuration(result.logs);
  if (duration !== null) {
    console.log(`PASS: Duration = ${duration} seconds`);
  } else {
    console.error("FAIL: Could not extract duration");
    failed++;
  }
  await client.deleteFile("input");
}

// Test 2: Audio extraction
{
  console.log("=== TEST 2: Audio ===");
  await client.writeFile("input", VIDEO);

  await client.exec("-i", "input", "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "output.wav");
  await client.readFile("output.wav", resolve(import.meta.dirname, "output.wav"));
  console.log("PASS: Extracted WAV");
  await client.deleteFile("output.wav");

  await client.exec("-i", "input", "-vn", "-acodec", "libmp3lame", "-q:a", "2", "output.mp3");
  await client.readFile("output.mp3", resolve(import.meta.dirname, "output.mp3"));
  console.log("PASS: Extracted MP3");
  await client.deleteFile("output.mp3");
  await client.deleteFile("input");
}

// Test 3: Frame extraction
{
  console.log("=== TEST 3: Frames ===");
  await client.writeFile("input", VIDEO);

  await client.exec("-i", "input", "-an", "-frames:v", "10", "frame_%03d.jpg");
  const files = await client.listDir("/");
  const frameFiles = files
    .filter((f) => f.name.startsWith("frame_") && f.name.endsWith(".jpg"))
    .map((f) => f.name)
    .sort();

  const outputDir = resolve(import.meta.dirname, "frames");
  await mkdir(outputDir, { recursive: true });
  for (const name of frameFiles) {
    await client.readFile(name, resolve(outputDir, name));
  }

  if (frameFiles.length === 10) {
    console.log(`PASS: Extracted ${frameFiles.length} frames`);
  } else {
    console.error(`FAIL: Expected 10 frames, got ${frameFiles.length}`);
    failed++;
  }

  for (const f of frameFiles) await client.deleteFile(f);
  await client.deleteFile("input");
}

await client.close();

// Test 4: Direct ffmpeg-style CLI
{
  console.log("=== TEST 4: Direct CLI ===");
  const directWav = resolve(import.meta.dirname, "direct.wav");
  const directFrames = resolve(import.meta.dirname, "direct_frames");
  await rm(directWav, { force: true });
  await rm(directFrames, { recursive: true, force: true });
  await mkdir(directFrames, { recursive: true });

  await $`bun run ${resolve(import.meta.dirname, "../src/cli.ts")} -i ${VIDEO} -vn -acodec pcm_s16le -ar 44100 -ac 2 ${directWav}`;
  if (await Bun.file(directWav).exists()) {
    console.log("PASS: Direct CLI extracted WAV");
  } else {
    console.error("FAIL: Direct CLI did not write WAV");
    failed++;
  }

  await $`bun run ${resolve(import.meta.dirname, "../src/cli.ts")} -i ${VIDEO} -an -frames:v 3 ${resolve(directFrames, "frame_%03d.jpg")}`;
  const directFrameFiles = Array.from(new Bun.Glob("frame_*.jpg").scanSync(directFrames));
  if (directFrameFiles.length === 3) {
    console.log("PASS: Direct CLI extracted frame sequence");
  } else {
    console.error(`FAIL: Direct CLI expected 3 frames, got ${directFrameFiles.length}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}

console.log("\nAll tests passed!");

// Zip result assets
const testDir = import.meta.dirname;
const zipPath = resolve(testDir, "results.zip");
console.log("Zipping result assets...");
await $`cd ${testDir} && zip -r results.zip output.wav output.mp3 frames/`;
console.log(`Created ${zipPath}`);

process.exit(0);
