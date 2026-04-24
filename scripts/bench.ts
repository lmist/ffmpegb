import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "bun";

const root = resolve(import.meta.dirname, "..");
const cli = resolve(root, "src/cli.ts");
const source = resolve(root, "test/test_video.mp4");
const outDir = resolve(root, "scratch/bench");
const resultsPath = resolve(outDir, "results.json");

interface BenchResult {
  name: string;
  command: string[];
  exitCode: number;
  wallMs: number;
  outputBytes: number;
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
    const full = resolve(path, entry);
    const candidate = Bun.file(full);
    if (await candidate.exists()) total += candidate.size;
  }
  return total;
}

async function run(name: string, args: string[], outputPath: string, timeoutMs = 60000): Promise<BenchResult> {
  const started = performance.now();
  const proc = spawn({
    cmd: ["bun", "run", cli, ...args],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  const wallMs = performance.now() - started;
  if (exitCode !== 0) {
    console.error(stdout);
    console.error(stderr);
  }
  return {
    name,
    command: ["bun", "run", "src/cli.ts", ...args],
    exitCode,
    wallMs: Math.round(wallMs),
    outputBytes: await pathSize(outputPath),
    stderrTail: stderr.split("\n").slice(-12).join("\n"),
  };
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const fixtureMkv = resolve(outDir, "fixture.mkv");
const transcodeMp4 = resolve(outDir, "fixture.transcoded.mp4");
const framesDir = resolve(outDir, "frames");
await mkdir(framesDir, { recursive: true });

const fixture = await run("create-mkv-fixture", [
  "-y",
  "-i", source,
  "-t", "2",
  "-c:v", "mpeg4",
  "-q:v", "5",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "96k",
  fixtureMkv,
], fixtureMkv);

if (fixture.exitCode !== 0) process.exit(fixture.exitCode);

const results: BenchResult[] = [fixture];
results.push(await run("auto-fast-mkv-to-mp4", ["-y", "-i", fixtureMkv, transcodeMp4], transcodeMp4));
results.push(await run("extract-5-jpegs", ["-y", "-i", source, "-an", "-frames:v", "5", resolve(framesDir, "frame_%03d.jpg")], framesDir, 30000));

const failed = results.filter((result) => result.exitCode !== 0 || result.outputBytes <= 0);
const payload = {
  generatedAt: new Date().toISOString(),
  fixture: {
    source: "test/test_video.mp4",
    mkvBytes: await pathSize(fixtureMkv),
  },
  results,
};

await writeFile(resultsPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(JSON.stringify(payload, null, 2));

if (failed.length > 0) {
  console.error(`Benchmark failed: ${failed.map((result) => result.name).join(", ")}`);
  process.exit(1);
}
