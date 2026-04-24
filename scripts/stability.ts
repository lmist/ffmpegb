import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "bun";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src/cli.ts");
const source = resolve(root, "test/test_video.mp4");
const workDir = resolve(root, "scratch/stability");
const fixtureDir = resolve(workDir, "fixtures");
const outputDir = resolve(workDir, "outputs");
const reportPath = resolve(workDir, "results.json");

interface CaseSpec {
  id: string;
  args: string[];
  outputPath: string;
  kind: "file" | "pattern";
  minBytes?: number;
  expectedCount?: number;
}

interface CaseResult {
  id: string;
  command: string[];
  exitCode: number;
  wallMs: number;
  outputBytes: number;
  outputCount: number;
  ok: boolean;
  stderrTail: string;
}

async function pathSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.size;
  } catch {
    return 0;
  }
  let total = 0;
  for await (const entry of new Bun.Glob("**/*").scan(path)) {
    try {
      const info = await stat(resolve(path, entry));
      if (info.isFile()) total += info.size;
    } catch {
      // Ignore files deleted by cleanup after a failed case.
    }
  }
  return total;
}

function patternToGlob(patternPath: string): string {
  return patternPath.split("/").pop()!.replace(/%0?\d*d/g, "*");
}

async function countGlob(dir: string, pattern: string): Promise<number> {
  return Array.from(new Bun.Glob(pattern).scanSync(dir)).length;
}

async function runCase(testCase: CaseSpec, timeoutMs = 25000): Promise<CaseResult> {
  const started = performance.now();
  const proc = spawn({
    cmd: ["bun", "run", cli, ...testCase.args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  const wallMs = Math.round(performance.now() - started);
  let outputBytes = 0;
  let outputCount = 0;
  if (testCase.kind === "file") {
    outputBytes = await pathSize(testCase.outputPath);
    outputCount = outputBytes > 0 ? 1 : 0;
  } else {
    outputBytes = await pathSize(outputDir);
    outputCount = await countGlob(outputDir, patternToGlob(testCase.outputPath));
  }

  const ok = exitCode === 0 &&
    outputBytes >= (testCase.minBytes ?? 1) &&
    (testCase.kind === "file" || outputCount === testCase.expectedCount);

  return {
    id: testCase.id,
    command: ["bun", "run", "src/cli.ts", ...testCase.args],
    exitCode,
    wallMs,
    outputBytes,
    outputCount,
    ok,
    stderrTail: stderr.split("\n").slice(-10).join("\n"),
  };
}

async function runFixture(args: string[], outputPath: string): Promise<void> {
  const result = await runCase({ id: `fixture-${outputPath}`, args, outputPath, kind: "file", minBytes: 256 }, 30000);
  if (!result.ok) {
    console.error(result.stderrTail);
    throw new Error(`Fixture generation failed: ${args.join(" ")}`);
  }
}

function addFileCase(cases: CaseSpec[], id: string, args: string[], extension: string, minBytes = 256): void {
  const outputPath = resolve(outputDir, `${id}.${extension}`);
  cases.push({ id, args: [...args, outputPath], outputPath, kind: "file", minBytes });
}

function addPatternCase(cases: CaseSpec[], id: string, args: string[], count: number): void {
  const outputPath = resolve(outputDir, `${id}_%03d.jpg`);
  cases.push({ id, args: [...args, outputPath], outputPath, kind: "pattern", minBytes: 1024, expectedCount: count });
}

await rm(workDir, { recursive: true, force: true });
await mkdir(fixtureDir, { recursive: true });
await mkdir(outputDir, { recursive: true });
await copyFile(source, resolve(fixtureDir, "source.mp4"));

await runFixture(["-y", "-i", source, "-t", "2", "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", resolve(fixtureDir, "short.mp4")], resolve(fixtureDir, "short.mp4"));
await runFixture(["-y", "-i", source, "-t", "2", "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", resolve(fixtureDir, "short.mkv")], resolve(fixtureDir, "short.mkv"));
await runFixture(["-y", "-i", source, "-t", "2", "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", resolve(fixtureDir, "audio.wav")], resolve(fixtureDir, "audio.wav"));
await runFixture(["-y", "-i", source, "-t", "2", "-vn", "-acodec", "libmp3lame", "-q:a", "4", resolve(fixtureDir, "audio.mp3")], resolve(fixtureDir, "audio.mp3"));

const cases: CaseSpec[] = [];
const videos = ["source.mp4", "short.mp4", "short.mkv"];
const frameVideos = ["source.mp4"];
const durations = ["0.25", "0.5", "1", "1.5"];
const qualities = ["3", "5", "8"];
const scales = ["160:120", "120:-1", "96:72"];
let id = 0;

for (const input of videos) {
  const inPath = resolve(fixtureDir, input);
  for (const duration of durations) {
    for (const quality of qualities) {
      addFileCase(cases, `v${++id}_mpeg4_${input.replace(/\W/g, "_")}_${duration}_${quality}`, ["-y", "-i", inPath, "-t", duration, "-an", "-c:v", "mpeg4", "-q:v", quality, "-pix_fmt", "yuv420p"], "mp4");
    }
    for (const scale of scales) {
      addFileCase(cases, `v${++id}_scale_${input.replace(/\W/g, "_")}_${duration}_${scale.replace(/\W/g, "_")}`, ["-y", "-i", inPath, "-t", duration, "-an", "-vf", `scale=${scale}`, "-c:v", "mpeg4", "-q:v", "6", "-pix_fmt", "yuv420p"], "mp4");
    }
    addFileCase(cases, `v${++id}_copy_mkv_${input.replace(/\W/g, "_")}_${duration}`, ["-y", "-i", inPath, "-t", duration, "-c", "copy"], "mkv");
    addFileCase(cases, `v${++id}_audio_wav_${input.replace(/\W/g, "_")}_${duration}`, ["-y", "-i", inPath, "-t", duration, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1"], "wav");
    addFileCase(cases, `v${++id}_audio_mp3_${input.replace(/\W/g, "_")}_${duration}`, ["-y", "-i", inPath, "-t", duration, "-vn", "-acodec", "libmp3lame", "-q:a", "5"], "mp3");
  }
}

for (const input of frameVideos) {
  const inPath = resolve(fixtureDir, input);
  for (const count of [1, 2, 3, 5, 8]) {
    addPatternCase(cases, `v${++id}_jpg_${input.replace(/\W/g, "_")}_${count}`, ["-y", "-i", inPath, "-an", "-frames:v", String(count)], count);
  }
}

for (const input of ["audio.wav", "audio.mp3"]) {
  const inPath = resolve(fixtureDir, input);
  for (const duration of durations) {
    for (const rate of ["8000", "16000", "44100"]) {
      for (const channels of ["1", "2"]) {
        addFileCase(cases, `a${++id}_wav_${input.replace(/\W/g, "_")}_${duration}_${rate}_${channels}`, ["-y", "-i", inPath, "-t", duration, "-vn", "-acodec", "pcm_s16le", "-ar", rate, "-ac", channels], "wav");
        addFileCase(cases, `a${++id}_mp3_${input.replace(/\W/g, "_")}_${duration}_${rate}_${channels}`, ["-y", "-i", inPath, "-t", duration, "-vn", "-acodec", "libmp3lame", "-q:a", "6", "-ar", rate, "-ac", channels], "mp3");
      }
    }
  }
}

const started = performance.now();
const results: CaseResult[] = [];
for (const testCase of cases) {
  const result = await runCase(testCase);
  results.push(result);
  if (!result.ok) {
    console.error(`FAIL ${result.id}`);
    console.error(result.stderrTail);
  }
}

const failed = results.filter((result) => !result.ok);
const report = {
  generatedAt: new Date().toISOString(),
  strategy: "FATE-style generated fixtures plus isolated direct-CLI command matrix",
  source: "test/test_video.mp4",
  fixtureBytes: {
    sourceMp4: await pathSize(resolve(fixtureDir, "source.mp4")),
    shortMp4: await pathSize(resolve(fixtureDir, "short.mp4")),
    shortMkv: await pathSize(resolve(fixtureDir, "short.mkv")),
    audioWav: await pathSize(resolve(fixtureDir, "audio.wav")),
    audioMp3: await pathSize(resolve(fixtureDir, "audio.mp3")),
  },
  summary: {
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    wallMs: Math.round(performance.now() - started),
  },
  results,
};

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Wrote ${reportPath}`);

if (failed.length > 0) {
  console.error(`Failed cases: ${failed.map((result) => result.id).join(", ")}`);
  process.exit(1);
}
