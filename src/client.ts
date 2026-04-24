import { FFmpeg } from "../vendor/ffmpeg/index.js";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getVendorDir(): string {
  if (__dirname.includes("$bunfs")) {
    return resolve(dirname(process.execPath), "vendor");
  }
  return resolve(__dirname, "../vendor");
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

    const vendorDir = getVendorDir();
    const workerURL = pathToFileURL(resolve(vendorDir, "ffmpeg", "bun-worker.js")).href;
    const coreURL = pathToFileURL(resolve(vendorDir, "core", "core.js")).href;
    const wasmURL = pathToFileURL(resolve(vendorDir, "core", "core.wasm")).href;

    console.log("Loading ffmpeg.wasm core (~31 MB)...");
    await this.ffmpeg.load({
      classWorkerURL: workerURL,
      coreURL,
      wasmURL,
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
    this.assertLoaded();
    const logs: ExecResult["logs"] = [];
    const cb = ({ type, message }: { type: string; message: string }) => {
      logs.push({ type, message });
    };

    this.ffmpeg.on("log", cb);
    try {
      const exitCode = await this.ffmpeg.exec(args);
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
