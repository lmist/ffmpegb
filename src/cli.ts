#!/usr/bin/env bun
import { FfmpegClient } from "./client.js";
import { mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

/**
 * Prints usage information.
 */
function printUsage() {
  console.log(`
ffmpegb - ffmpeg.wasm CLI wrapper powered by Bun workers

Usage:
  ffmpegb [ffmpeg args...]

Commands:
  ffmpegb -i <input> <output>               Run ffmpeg-style commands directly
  ffmpegb duration <input>                  Print video duration in seconds
  ffmpegb audio <input>                     Extract audio to <input>.wav and <input>.mp3
  ffmpegb frames <input> [--count=N]        Extract frames as JPEGs to <input>_frames/
  ffmpegb run <input> -- <ffmpeg args>      Legacy arbitrary command wrapper

Options:
  --count=N      Number of frames to extract (default: 100)
  --help         Show this help message

Examples:
  ffmpegb -i video.mp4 audio.wav
  ffmpegb -i video.mp4 -vf scale=320:240 output.mp4
  ffmpegb duration video.mp4
  ffmpegb audio video.mp4
  ffmpegb frames video.mp4 --count=100
  ffmpegb run video.mp4 -- -vf scale=320:240 output.mp4
`);
}

/**
 * Parses command-line arguments.
 */
function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const input = args[1];
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let seenDashDash = false;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    if (seenDashDash) {
      positional.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, input, flags, positional };
}

/**
 * Extracts duration from ffmpeg log output.
 */
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

const LEGACY_COMMANDS = new Set(["duration", "audio", "frames", "run"]);
const OPTIONS_WITHOUT_VALUES = new Set([
  "-an",
  "-dn",
  "-hide_banner",
  "-nostats",
  "-nostdin",
  "-n",
  "-shortest",
  "-sn",
  "-stats",
  "-vn",
  "-y",
]);

interface DirectCommandPlan {
  args: string[];
  inputs: Array<{ virtualPath: string; localPath: string }>;
  outputs: Array<{ virtualPath: string; localPath: string; pattern: boolean }>;
}

function isProtocolPath(path: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path);
}

function isLocalPathCandidate(path: string): boolean {
  return path !== "-" && !isProtocolPath(path);
}

async function localFileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

function makeVirtualInputPath(localPath: string, index: number): string {
  const ext = extname(localPath);
  const name = basename(localPath, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "input";
  return `${name}_${index}${ext}`;
}

function makeVirtualOutputPath(localPath: string, index: number): string {
  const base = basename(localPath).replace(/[^a-zA-Z0-9.%_-]/g, "_") || `output_${index}`;
  return base;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(pattern: string): RegExp {
  const token = "__FFMPEGB_NUMBER__";
  const escaped = escapeRegExp(pattern).replace(/%0?\d*d/g, token);
  return new RegExp(`^${escaped.replaceAll(token, "\\d+")}$`);
}

function shouldPrintLog(message: string): boolean {
  return message !== "Aborted()";
}

function optionTakesValue(arg: string): boolean {
  if (!arg.startsWith("-") || arg === "-") return false;
  if (arg.includes("=")) return false;
  return !OPTIONS_WITHOUT_VALUES.has(arg);
}

async function planDirectCommand(rawArgs: string[]): Promise<DirectCommandPlan> {
  const args = [...rawArgs];
  const inputs: DirectCommandPlan["inputs"] = [];
  const outputs: DirectCommandPlan["outputs"] = [];
  let expectingOptionValue = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "-i") {
      const inputPath = args[i + 1];
      if (inputPath && isLocalPathCandidate(inputPath) && await localFileExists(inputPath)) {
        const virtualPath = makeVirtualInputPath(inputPath, inputs.length + 1);
        inputs.push({ virtualPath, localPath: inputPath });
        args[i + 1] = virtualPath;
      }
      i++;
      expectingOptionValue = false;
      continue;
    }

    if (expectingOptionValue) {
      expectingOptionValue = false;
      continue;
    }

    if (arg.startsWith("-") && arg !== "-") {
      expectingOptionValue = optionTakesValue(arg);
      continue;
    }

    if (!isLocalPathCandidate(arg)) continue;

    const virtualPath = makeVirtualOutputPath(arg, outputs.length + 1);
    outputs.push({
      virtualPath,
      localPath: arg,
      pattern: virtualPath.includes("%"),
    });
    args[i] = virtualPath;
  }

  return { args, inputs, outputs };
}

async function runDirectCommand(client: FfmpegClient, rawArgs: string[]): Promise<void> {
  const plan = await planDirectCommand(rawArgs);

  for (const input of plan.inputs) {
    await client.writeFile(input.virtualPath, input.localPath);
  }

  const result = await client.exec(...plan.args);
  result.logs.filter((l) => shouldPrintLog(l.message)).forEach((l) => {
    const write = l.type === "stderr" ? console.error : console.log;
    write(l.message);
  });

  const files = await client.listDir("/");
  for (const output of plan.outputs) {
    await mkdir(dirname(resolve(output.localPath)), { recursive: true });

    if (!output.pattern) {
      await client.readFile(output.virtualPath, output.localPath);
      continue;
    }

    const matcher = patternToRegExp(output.virtualPath);
    const generated = files
      .filter((f) => !f.isDir && matcher.test(f.name))
      .map((f) => f.name)
      .sort();
    for (const virtualName of generated) {
      await client.readFile(virtualName, resolve(dirname(output.localPath), virtualName));
    }
  }

  process.exitCode = result.exitCode;
}

/**
 * Main entry point.
 */
async function main() {
  const { command, input, flags, positional } = parseArgs(Bun.argv);
  const directArgs = Bun.argv.slice(2);
  const isLegacyCommand = LEGACY_COMMANDS.has(command);

  if (isLegacyCommand && !input) {
    console.error("Error: missing input file");
    printUsage();
    process.exit(1);
  }

  const client = new FfmpegClient();
  try {
    await client.launch();

    if (!isLegacyCommand) {
      await runDirectCommand(client, directArgs);
    } else if (command === "duration") {
      console.log(`Analyzing ${input}...`);
      await client.writeFile("input", input!);
      const result = await client.exec("-i", "input");
      const duration = extractDuration(result.logs);
      if (duration !== null) {
        console.log(`Duration: ${duration} seconds`);
      } else {
        console.error("Could not extract duration. Logs:");
        result.logs.forEach((l) => console.error(l.message));
        process.exit(1);
      }
    } else if (command === "audio") {
      console.log(`Extracting audio from ${input}...`);
      await client.writeFile("input", input!);

      const wavOutput = input!.replace(/\.[^.]+$/, ".wav");
      const mp3Output = input!.replace(/\.[^.]+$/, ".mp3");

      console.log(`Extracting WAV -> ${wavOutput}`);
      let result = await client.exec("-i", "input", "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", "output.wav");
      if (result.exitCode !== 0 && result.exitCode !== undefined) {
        console.warn("WAV extraction had non-zero exit code, but may still have produced output.");
      }
      await client.readFile("output.wav", wavOutput);
      console.log(`Wrote ${wavOutput}`);

      await client.deleteFile("output.wav");

      console.log(`Extracting MP3 -> ${mp3Output}`);
      result = await client.exec("-i", "input", "-vn", "-acodec", "libmp3lame", "-q:a", "2", "output.mp3");
      if (result.exitCode !== 0 && result.exitCode !== undefined) {
        console.warn("MP3 extraction had non-zero exit code, but may still have produced output.");
      }
      await client.readFile("output.mp3", mp3Output);
      console.log(`Wrote ${mp3Output}`);
    } else if (command === "frames") {
      const count = parseInt(String(flags.count ?? "10"), 10);
      console.log(`Extracting ${count} frames from ${input}...`);
      await client.writeFile("input", input!);

      const outputDir = input!.replace(/\.[^.]+$/, "_frames");
      await mkdir(outputDir, { recursive: true });

      // Extract frames (avoid complex filters to stay within WASM memory limits)
      const result = await client.exec(
        "-i", "input",
        "-an",
        "-frames:v", String(count),
        "frame_%03d.jpg"
      );

      const files = await client.listDir("/");
      const frameFiles = files
        .filter((f) => f.name.startsWith("frame_") && f.name.endsWith(".jpg"))
        .map((f) => f.name)
        .sort();

      console.log(`Found ${frameFiles.length} frames.`);
      for (const name of frameFiles) {
        const localPath = `${outputDir}/${name}`;
        await client.readFile(name, localPath);
      }
      console.log(`Wrote ${frameFiles.length} frames to ${outputDir}/`);
    } else if (command === "run") {
      if (positional.length === 0) {
        console.error("Error: no ffmpeg arguments provided after --");
        process.exit(1);
      }
      await client.writeFile("input", input!);
      const args = positional.map((a) => (a === "{input}" ? "input" : a));
      console.log("Running: ffmpeg", args.join(" "));
      const result = await client.exec(...args);
      console.log("Exit code:", result.exitCode);
      result.logs.forEach((l) => console.log(l.message));
    } else {
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
