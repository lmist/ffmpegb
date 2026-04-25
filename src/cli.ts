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
  ffmpegb probe <input> [--json]            Print ffprobe-like metadata from ffmpeg logs
  ffmpegb audio <input>                     Extract audio to <input>.wav and <input>.mp3
  ffmpegb frames <input> [--count=N]        Extract frames as JPEGs to <input>_frames/
  ffmpegb run <input> -- <ffmpeg args>      Legacy arbitrary command wrapper

Options:
  --count=N      Number of frames to extract (default: 100)
  --json         Emit JSON for probe
  --help         Show this help message

Examples:
  ffmpegb -i video.mp4 audio.wav
  ffmpegb -i video.mp4 -vf scale=320:240 output.mp4
  ffmpegb duration video.mp4
  ffmpegb probe video.mp4 --json
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
  const match = text.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (match) {
    const hours = parseFloat(match[1]);
    const minutes = parseFloat(match[2]);
    const seconds = parseFloat(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

interface ProbeStream {
  index: string;
  type: "video" | "audio" | "subtitle" | "data" | "unknown";
  codec?: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: string;
  fps?: number;
  raw: string;
}

interface ProbeInfo {
  duration: number | null;
  start: number | null;
  bitrate: string | null;
  streams: ProbeStream[];
}

function parseProbeInfo(logs: Array<{ type: string; message: string }>): ProbeInfo {
  const text = logs.map((l) => l.message).join("\n");
  const durationMatch = text.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?),\s+start:\s+([^,]+),\s+bitrate:\s+([^\n]+)/);
  const streams: ProbeStream[] = [];

  for (const line of text.split("\n")) {
    const streamMatch = line.match(/Stream #([^\s:]+:\d+)(?:\[[^\]]+\])?(?:\([^)]+\))?:\s+([^:]+):\s+(.+)/);
    if (!streamMatch) continue;
    const typeText = streamMatch[2]!.toLowerCase();
    const rawDetails = streamMatch[3]!;
    const stream: ProbeStream = {
      index: streamMatch[1]!,
      type: typeText.includes("video") ? "video" :
        typeText.includes("audio") ? "audio" :
        typeText.includes("subtitle") ? "subtitle" :
        typeText.includes("data") ? "data" : "unknown",
      codec: rawDetails.split(",")[0]?.trim(),
      raw: line.trim(),
    };

    const sizeMatch = rawDetails.match(/,\s*(\d{2,5})x(\d{2,5})(?:\s|,|\[)/);
    if (sizeMatch) {
      stream.width = Number(sizeMatch[1]);
      stream.height = Number(sizeMatch[2]);
    }
    const sampleMatch = rawDetails.match(/,\s*(\d+)\s+Hz,\s*([^,]+)/);
    if (sampleMatch) {
      stream.sampleRate = Number(sampleMatch[1]);
      stream.channels = sampleMatch[2]!.trim();
    }
    const fpsMatch = rawDetails.match(/,\s*([0-9.]+)\s+fps(?:,|\s)/);
    if (fpsMatch) stream.fps = Number(fpsMatch[1]);
    streams.push(stream);
  }

  return {
    duration: extractDuration(logs),
    start: durationMatch ? Number(durationMatch[4]) : null,
    bitrate: durationMatch ? durationMatch[5]!.trim() : null,
    streams,
  };
}

const LEGACY_COMMANDS = new Set(["duration", "probe", "audio", "frames", "run"]);
const OPTIONS_WITH_REQUIRED_VALUES = new Set([
  "-ac",
  "-acodec",
  "-af",
  "-ar",
  "-aspect",
  "-b",
  "-bufsize",
  "-c",
  "-codec",
  "-crf",
  "-filter",
  "-filter:a",
  "-filter:v",
  "-filter_complex",
  "-filter_complex_script",
  "-f",
  "-frames",
  "-frames:a",
  "-frames:v",
  "-i",
  "-itsoffset",
  "-map",
  "-map_chapters",
  "-map_metadata",
  "-metadata",
  "-metadata:s:a",
  "-metadata:s:v",
  "-movflags",
  "-pix_fmt",
  "-preset",
  "-profile",
  "-profile:v",
  "-q",
  "-q:a",
  "-q:v",
  "-r",
  "-s",
  "-ss",
  "-strict",
  "-t",
  "-threads",
  "-to",
  "-vf",
  "-vframes",
]);
const OPTIONS_WITHOUT_VALUES = new Set([
  "-an",
  "-benchmark",
  "-copyts",
  "-dn",
  "-genpts",
  "-hide_banner",
  "-ignore_unknown",
  "-nostats",
  "-nostdin",
  "-n",
  "-re",
  "-shortest",
  "-sn",
  "-stats",
  "-vn",
  "-y",
]);

interface DirectCommandPlan {
  args: string[];
  inputs: Array<{ virtualPath: string; mountPoint: string; virtualName: string; localPath: string }>;
  outputs: Array<{ virtualPath: string; mountPoint: string; virtualName: string; localDir: string; localPath: string; pattern: boolean; argIndex: number }>;
  autoFastTranscode: boolean;
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

let directCommandSequence = 0;

function makeInputMountPoint(commandIndex: number, inputIndex: number): string {
  return `/input_${commandIndex}_${inputIndex}`;
}

function makeVirtualOutputPath(localPath: string, index: number): string {
  const base = basename(localPath).replace(/[^a-zA-Z0-9.%_-]/g, "_") || `output_${index}`;
  return base;
}

function makeOutputMountPoint(commandIndex: number, outputIndex: number): string {
  return `/output_${commandIndex}_${outputIndex}`;
}

function shouldPrintLog(message: string): boolean {
  return message !== "Aborted()";
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function optionTakesValue(arg: string): boolean {
  if (!arg.startsWith("-") || arg === "-") return false;
  if (arg.includes("=")) return false;
  if (OPTIONS_WITHOUT_VALUES.has(arg)) return false;
  if (OPTIONS_WITH_REQUIRED_VALUES.has(arg)) return true;
  if (/^-(?:b|c|codec|filter|frames|map|metadata|profile|q|qscale|tag):/.test(arg)) return true;
  // FFmpeg has many long-tail options with values. Defaulting to value-taking
  // avoids accidentally rewriting option values as output files.
  return true;
}

function hasExplicitProcessingOptions(args: string[]): boolean {
  return args.some((arg) =>
    arg === "-c" ||
    arg === "-codec" ||
    (arg.startsWith("-") && arg.endsWith("codec")) ||
    arg.startsWith("-c:") ||
    arg.startsWith("-codec:") ||
    arg.startsWith("-filter") ||
    arg === "-vf" ||
    arg === "-af" ||
    arg === "-map" ||
    arg === "-b" ||
    arg.startsWith("-b:") ||
    arg === "-crf" ||
    arg === "-preset"
  );
}

function canAutoFastTranscode(rawArgs: string[], inputs: DirectCommandPlan["inputs"], outputs: DirectCommandPlan["outputs"]): boolean {
  if (inputs.length !== 1 || outputs.length !== 1) return false;
  if (outputs[0]!.pattern) return false;
  if (hasExplicitProcessingOptions(rawArgs)) return false;
  return extname(inputs[0]!.localPath).toLowerCase() === ".mkv" &&
    extname(outputs[0]!.localPath).toLowerCase() === ".mp4";
}

async function planDirectCommand(rawArgs: string[]): Promise<DirectCommandPlan> {
  const args = [...rawArgs];
  const commandIndex = ++directCommandSequence;
  const inputs: DirectCommandPlan["inputs"] = [];
  const outputs: DirectCommandPlan["outputs"] = [];
  let expectingOptionValue = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === "-i") {
      const inputPath = args[i + 1];
      if (inputPath && isLocalPathCandidate(inputPath) && await localFileExists(inputPath)) {
        const inputIndex = inputs.length + 1;
        const virtualName = makeVirtualInputPath(inputPath, inputIndex);
        const mountPoint = makeInputMountPoint(commandIndex, inputIndex);
        const virtualPath = `${mountPoint}/${virtualName}`;
        inputs.push({ virtualPath, mountPoint, virtualName, localPath: inputPath });
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

    const outputIndex = outputs.length + 1;
    const virtualName = makeVirtualOutputPath(arg, outputIndex);
    const mountPoint = makeOutputMountPoint(commandIndex, outputIndex);
    const virtualPath = `${mountPoint}/${virtualName}`;
    outputs.push({
      virtualPath,
      mountPoint,
      virtualName,
      localDir: dirname(resolve(arg)),
      localPath: arg,
      pattern: virtualPath.includes("%"),
      argIndex: i,
    });
    args[i] = virtualPath;
  }

  const autoFastTranscode = canAutoFastTranscode(rawArgs, inputs, outputs);
  if (autoFastTranscode) {
    args.splice(outputs[0]!.argIndex, 0, "-c:v", "mpeg4", "-q:v", "5", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-sn");
  }

  return { args, inputs, outputs, autoFastTranscode };
}

async function executeDirectCommand(client: FfmpegClient, rawArgs: string[]) {
  const plan = await planDirectCommand(rawArgs);
  if (plan.autoFastTranscode) {
    console.error("Using fast wasm MP4 transcode profile: mpeg4 q=5 + AAC 160k. Add codec/filter options to override.");
  }

  const inputBytes = plan.inputs.reduce((sum, input) => sum + Bun.file(input.localPath).size, 0);
  if (inputBytes > 512 * 1024 * 1024) {
    console.error(`Large input: mounting ${formatBytes(inputBytes)} through disk-backed BUNFS to avoid MEMFS copies. Codec work still runs inside the wasm heap.`);
  }

  for (const input of plan.inputs) {
    await client.mountFile(input.mountPoint, input.virtualName, input.localPath);
  }

  for (const output of plan.outputs) {
    await mkdir(output.localDir, { recursive: true });
    await client.mountDirectory(output.mountPoint, output.localDir, true);
  }

  return { plan, result: await client.exec(...plan.args) };
}

async function runDirectCommand(client: FfmpegClient, rawArgs: string[]): Promise<void> {
  const { result } = await executeDirectCommand(client, rawArgs);
  result.logs.filter((l) => shouldPrintLog(l.message)).forEach((l) => {
    const write = l.type === "stderr" ? console.error : console.log;
    write(l.message);
  });

  process.exitCode = result.exitCode;
}

function replaceExtension(path: string, extension: string): string {
  return /\.[^./]+$/.test(path) ? path.replace(/\.[^.]+$/, extension) : `${path}${extension}`;
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
      const { result } = await executeDirectCommand(client, ["-hide_banner", "-i", input!]);
      const duration = extractDuration(result.logs);
      if (duration !== null) {
        console.log(`Duration: ${duration} seconds`);
      } else {
        console.error("Could not extract duration. Logs:");
        result.logs.forEach((l) => console.error(l.message));
        process.exit(1);
      }
    } else if (command === "probe") {
      const { result } = await executeDirectCommand(client, ["-hide_banner", "-i", input!]);
      const info = parseProbeInfo(result.logs);
      if (flags.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(`Duration: ${info.duration ?? "unknown"} seconds`);
        if (info.bitrate) console.log(`Bitrate: ${info.bitrate}`);
        for (const stream of info.streams) {
          const details = [
            stream.codec,
            stream.width && stream.height ? `${stream.width}x${stream.height}` : undefined,
            stream.sampleRate ? `${stream.sampleRate} Hz` : undefined,
            stream.channels,
            stream.fps ? `${stream.fps} fps` : undefined,
          ].filter(Boolean).join(", ");
          console.log(`Stream ${stream.index}: ${stream.type}${details ? `, ${details}` : ""}`);
        }
      }
    } else if (command === "audio") {
      console.log(`Extracting audio from ${input}...`);
      const wavOutput = replaceExtension(input!, ".wav");
      const mp3Output = replaceExtension(input!, ".mp3");

      console.log(`Extracting WAV -> ${wavOutput}`);
      let { result } = await executeDirectCommand(client, ["-y", "-i", input!, "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", wavOutput]);
      if (result.exitCode !== 0 && result.exitCode !== undefined) {
        console.warn("WAV extraction had non-zero exit code, but may still have produced output.");
      }
      console.log(`Wrote ${wavOutput}`);

      console.log(`Extracting MP3 -> ${mp3Output}`);
      ({ result } = await executeDirectCommand(client, ["-y", "-i", input!, "-vn", "-acodec", "libmp3lame", "-q:a", "2", mp3Output]));
      if (result.exitCode !== 0 && result.exitCode !== undefined) {
        console.warn("MP3 extraction had non-zero exit code, but may still have produced output.");
      }
      console.log(`Wrote ${mp3Output}`);
    } else if (command === "frames") {
      const count = parseInt(String(flags.count ?? "10"), 10);
      console.log(`Extracting ${count} frames from ${input}...`);

      const outputDir = replaceExtension(input!, "_frames");
      await mkdir(outputDir, { recursive: true });
      const pattern = resolve(outputDir, "frame_%03d.jpg");

      const { result } = await executeDirectCommand(client, [
        "-y",
        "-i", input!,
        "-an",
        "-frames:v", String(count),
        pattern,
      ]);
      if (result.exitCode !== 0 && result.exitCode !== undefined) {
        console.warn("Frame extraction had non-zero exit code, but may still have produced output.");
      }

      const frameFiles = Array.from(new Bun.Glob("frame_*.jpg").scanSync(outputDir)).sort();

      console.log(`Found ${frameFiles.length} frames.`);
      console.log(`Wrote ${frameFiles.length} frames to ${outputDir}/`);
    } else if (command === "run") {
      if (positional.length === 0) {
        console.error("Error: no ffmpeg arguments provided after --");
        process.exit(1);
      }
      const args = positional.map((a) => (a === "{input}" ? "input" : a));
      if (!args.includes("-i")) args.unshift("-i", input!);
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "input") args[i] = input!;
      }
      console.log("Running: ffmpegb", args.join(" "));
      const { result } = await executeDirectCommand(client, args);
      console.log("Exit code:", result.exitCode);
      result.logs.forEach((l) => console.log(l.message));
      process.exitCode = result.exitCode;
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
