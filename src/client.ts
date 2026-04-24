import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { existsSync } from "node:fs";
import { materializeEmbeddedVendor } from "./embedded-vendor.js";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getVendorDir(): Promise<string> {
  if (__dirname.includes("$bunfs")) {
    return await materializeEmbeddedVendor();
  }
  return resolve(__dirname, "../vendor");
}

function firstExisting(...paths: string[]): string {
  const found = paths.find((path) => existsSync(path));
  if (!found) throw new Error(`Missing ffmpeg.wasm artifact. Tried: ${paths.join(", ")}`);
  return found;
}

function firstExistingOptional(...paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

export interface ExecResult {
  exitCode: number;
  logs: Array<{ type: string; message: string }>;
}

/**
 * Manages ffmpeg.wasm through Bun's Web Worker implementation.
 */
export class FfmpegClient {
  private ffmpeg = new FFmpeg();
  private loaded = false;

  /**
   * Starts the vendored ffmpeg.wasm runtime.
   */
  async launch(): Promise<void> {
    if (this.loaded) return;

    const vendorDir = await getVendorDir();
    const coreDir = process.env.FFMPEGB_CORE_DIR || resolve(vendorDir, "core");
    const workerURL = pathToFileURL(resolve(vendorDir, "ffmpeg", "bun-worker.js")).href;
    const coreURL = pathToFileURL(firstExisting(resolve(coreDir, "core.js"), resolve(coreDir, "ffmpeg-core.js"))).href;
    const wasmURL = pathToFileURL(firstExisting(resolve(coreDir, "core.wasm"), resolve(coreDir, "ffmpeg-core.wasm"))).href;
    const coreWorkerPath = process.env.FFMPEGB_CORE_WORKER || firstExistingOptional(
      resolve(coreDir, "core.worker.js"),
      resolve(coreDir, "ffmpeg-core.worker.js")
    );

    console.log("Loading ffmpeg.wasm core (~31 MB)...");
    await this.ffmpeg.load({
      classWorkerURL: workerURL,
      coreURL,
      wasmURL,
      ...(coreWorkerPath ? { workerURL: pathToFileURL(coreWorkerPath).href } : {}),
    });
    this.loaded = true;
    console.log("ffmpeg.wasm core loaded.");
  }

  /**
   * Copies a local file into ffmpeg.wasm's virtual filesystem.
   */
  async writeFile(virtualPath: string, localPath: string): Promise<void> {
    this.assertLoaded();
    const data = new Uint8Array(await Bun.file(localPath).arrayBuffer());
    await this.ffmpeg.writeFile(virtualPath, data);
  }

  /**
   * Mounts a local host file read-only inside ffmpeg.wasm without copying it into MEMFS.
   */
  async mountFile(mountPoint: string, virtualName: string, localPath: string): Promise<string> {
    this.assertLoaded();
    await this.ffmpeg.createDir(mountPoint);
    const file = Bun.file(localPath);
    await this.ffmpeg.mount("BUNFS" as any, {
      files: [{
        name: virtualName,
        path: localPath,
        size: file.size,
        lastModified: file.lastModified,
      }],
    }, mountPoint);
    return `${mountPoint}/${virtualName}`;
  }

  /**
   * Mounts a local host directory writable inside ffmpeg.wasm.
   */
  async mountDirectory(mountPoint: string, localPath: string, write = false): Promise<void> {
    this.assertLoaded();
    await this.ffmpeg.createDir(mountPoint);
    await this.ffmpeg.mount("BUNFS" as any, {
      rootPath: localPath,
      write,
    }, mountPoint);
  }

  /**
   * Copies data from ffmpeg.wasm's virtual filesystem to a local file.
   */
  async readFile(virtualPath: string, localPath: string): Promise<void> {
    this.assertLoaded();
    const data = await this.ffmpeg.readFile(virtualPath);
    if (typeof data === "string") {
      await Bun.write(localPath, data);
      return;
    }
    await Bun.write(localPath, data);
  }

  /**
   * Reads a text file from ffmpeg.wasm's virtual filesystem.
   */
  async readTextFile(virtualPath: string): Promise<string> {
    this.assertLoaded();
    const data = await this.ffmpeg.readFile(virtualPath, "utf8");
    if (typeof data === "string") return data;
    return new TextDecoder().decode(data);
  }

  /**
   * Executes an ffmpeg command.
   */
  async exec(...args: string[]): Promise<ExecResult> {
    return await this.execWithTimeout(-1, ...args);
  }

  /**
   * Executes an ffmpeg command with a runtime timeout in milliseconds.
   */
  async execWithTimeout(timeout: number, ...args: string[]): Promise<ExecResult> {
    this.assertLoaded();
    const logs: ExecResult["logs"] = [];
    const cb = ({ type, message }: { type: string; message: string }) => {
      logs.push({ type, message });
    };

    this.ffmpeg.on("log", cb);
    try {
      const exitCode = await this.ffmpeg.exec(args, timeout);
      return { exitCode, logs };
    } finally {
      this.ffmpeg.off("log", cb);
    }
  }

  /**
   * Lists a directory in ffmpeg.wasm's virtual filesystem.
   */
  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    this.assertLoaded();
    return await this.ffmpeg.listDir(path);
  }

  /**
   * Deletes a file in ffmpeg.wasm's virtual filesystem.
   */
  async deleteFile(path: string): Promise<void> {
    this.assertLoaded();
    await this.ffmpeg.deleteFile(path);
  }

  /**
   * Shuts down the worker.
   */
  async close(): Promise<void> {
    if (this.loaded) {
      this.ffmpeg.terminate();
      this.ffmpeg = new FFmpeg();
      this.loaded = false;
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error("Client not launched");
  }
}
