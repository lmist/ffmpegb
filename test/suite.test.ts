import { FfmpegClient } from "../src/client.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const VIDEO = resolve(import.meta.dirname, "test_video.mp4");
const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "src/cli.ts");
const SCRATCH = resolve(ROOT, "scratch/test-suite");

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

// Test 4: BUNFS filesystem operations
{
  console.log("=== TEST 4: BUNFS filesystem ops ===");
  const hostDir = resolve(SCRATCH, "bunfs");
  await rm(hostDir, { recursive: true, force: true });
  await mkdir(hostDir, { recursive: true });
  const seed = resolve(SCRATCH, "seed.txt");
  await writeFile(seed, "bunfs smoke\n");

  await client.mountDirectory("/host_ops", hostDir, true);
  await client.writeFile("/host_ops/a.txt", seed);
  await client.rename("/host_ops/a.txt", "/host_ops/b.txt");
  await client.createDir("/host_ops/nested");
  await client.writeFile("/host_ops/nested/c.txt", seed);
  await client.deleteFile("/host_ops/nested/c.txt");
  await client.deleteDir("/host_ops/nested");

  const renamedExists = await Bun.file(resolve(hostDir, "b.txt")).exists();
  const nestedExists = await Bun.file(resolve(hostDir, "nested")).exists();
  if (renamedExists && !nestedExists) {
    console.log("PASS: BUNFS rename, mkdir, unlink, and rmdir");
  } else {
    console.error("FAIL: BUNFS host filesystem operations did not persist correctly");
    failed++;
  }
}

await client.close();

// Test 5: Direct ffmpeg-style CLI
{
  console.log("=== TEST 5: Direct CLI ===");
  const directWav = resolve(import.meta.dirname, "direct.wav");
  const directFrames = resolve(import.meta.dirname, "direct_frames");
  await rm(directWav, { force: true });
  await rm(directFrames, { recursive: true, force: true });
  await mkdir(directFrames, { recursive: true });

  await $`bun run ${CLI} -i ${VIDEO} -vn -acodec pcm_s16le -ar 44100 -ac 2 ${directWav}`;
  if (await Bun.file(directWav).exists()) {
    console.log("PASS: Direct CLI extracted WAV");
  } else {
    console.error("FAIL: Direct CLI did not write WAV");
    failed++;
  }

  await $`bun run ${CLI} -i ${VIDEO} -an -frames:v 3 ${resolve(directFrames, "frame_%03d.jpg")}`;
  const directFrameFiles = Array.from(new Bun.Glob("frame_*.jpg").scanSync(directFrames));
  if (directFrameFiles.length === 3) {
    console.log("PASS: Direct CLI extracted frame sequence");
  } else {
    console.error(`FAIL: Direct CLI expected 3 frames, got ${directFrameFiles.length}`);
    failed++;
  }
}

// Test 6: Complex direct CLI planning
{
  console.log("=== TEST 6: Complex Direct CLI ===");
  const directComplex = resolve(SCRATCH, "complex");
  await rm(directComplex, { recursive: true, force: true });
  await mkdir(directComplex, { recursive: true });
  const filteredMp4 = resolve(directComplex, "filter-map.mp4");
  const mappedWav = resolve(directComplex, "mapped.wav");
  const mappedMp3 = resolve(directComplex, "mapped.mp3");
  const filter = "[0:v]scale=128:96[v]";
  const mapLabel = "[v]";

  await $`bun run ${CLI} -y -i ${VIDEO} -t 0.5 -filter_complex ${filter} -map ${mapLabel} -an -c:v mpeg4 -q:v 6 -f mp4 ${filteredMp4}`;
  await $`bun run ${CLI} -y -i ${VIDEO} -t 0.5 -map 0:a:0 -vn -acodec pcm_s16le ${mappedWav} -map 0:a:0 -vn -acodec libmp3lame -q:a 5 ${mappedMp3}`;

  const ok = await Bun.file(filteredMp4).exists() &&
    await Bun.file(mappedWav).exists() &&
    await Bun.file(mappedMp3).exists();
  if (ok) {
    console.log("PASS: Complex direct CLI filter/map and multi-output command");
  } else {
    console.error("FAIL: Complex direct CLI outputs missing");
    failed++;
  }
}

// Test 7: Legacy commands use direct mounted IO
{
  console.log("=== TEST 7: Legacy direct-mounted commands ===");
  const legacyInput = resolve(SCRATCH, "legacy.mp4");
  await Bun.write(legacyInput, Bun.file(VIDEO));
  await $`bun run ${CLI} probe ${legacyInput} --json`;
  await $`bun run ${CLI} audio ${legacyInput}`;
  await $`bun run ${CLI} frames ${legacyInput} --count=4`;

  const legacyFrames = Array.from(new Bun.Glob("frame_*.jpg").scanSync(resolve(SCRATCH, "legacy_frames")));
  const ok = await Bun.file(resolve(SCRATCH, "legacy.wav")).exists() &&
    await Bun.file(resolve(SCRATCH, "legacy.mp3")).exists() &&
    legacyFrames.length === 4;
  if (ok) {
    console.log("PASS: Legacy probe/audio/frames use direct-mounted IO");
  } else {
    console.error("FAIL: Legacy direct-mounted commands missing outputs");
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
