import { chromium, Browser, Page } from "playwright-core";
import { BROWSER_HTML } from "./browser-api.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vendorDir = resolve(__dirname, "../vendor");

/**
 * Encodes a Uint8Array to a base64 string.
 */
function encodeBase64(data: Uint8Array): string {
  let binary = "";
  const len = data.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/**
 * Decodes a base64 string to a Uint8Array.
 */
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Maps a requested URL path to a local vendor file path.
 */
function mapUrlToPath(urlPath: string): string | null {
  if (urlPath.startsWith("/ffmpeg/")) {
    return resolve(vendorDir, "ffmpeg", urlPath.slice("/ffmpeg/".length));
  }
  if (urlPath.startsWith("/util/")) {
    return resolve(vendorDir, "util", urlPath.slice("/util/".length));
  }
  if (urlPath.startsWith("/core/")) {
    return resolve(vendorDir, "core", urlPath.slice("/core/".length));
  }
  return null;
}

/**
 * Determines the MIME type for a file based on its extension.
 */
function getMimeType(path: string): string {
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

export interface ExecResult {
  exitCode: number;
  logs: Array<{ type: string; message: string }>;
}

/**
 * Manages a headless browser instance running ffmpeg.wasm.
 */
export class FfmpegClient {
  private browser?: Browser;
  private page?: Page;
  private loaded = false;

  private server?: ReturnType<typeof Bun.serve>;

  /**
   * Starts a local HTTP server to serve vendor files and the HTML page.
   */
  private startServer(): number {
    const server = Bun.serve({
      port: 0, // random available port
      fetch: async (req) => {
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (pathname === "/") {
          return new Response(BROWSER_HTML, {
            headers: { "Content-Type": "text/html" },
          });
        }

        const filePath = mapUrlToPath(pathname);
        if (!filePath) {
          return new Response("Not found", { status: 404 });
        }

        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) {
          return new Response("Not found: " + pathname, { status: 404 });
        }

        return new Response(file, {
          headers: {
            "Content-Type": getMimeType(filePath),
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    });

    this.server = server;
    return server.port;
  }

  /**
   * Launches the browser, injects the ffmpeg.wasm runtime, and loads the core.
   */
  async launch(): Promise<void> {
    const port = this.startServer();
    const baseUrl = `http://localhost:${port}`;

    this.browser = await chromium.launch({ headless: true });
    this.page = await this.browser.newPage();

    this.page.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("ffmpegb init error")) {
        console.error("[Browser]", text);
      }
    });
    this.page.on("pageerror", (err) => {
      console.error("[Browser Page Error]", err.message);
    });

    // Navigate to the local server
    await this.page.goto(baseUrl);

    // Wait for the API to initialize or error out
    await this.page.waitForFunction(
      () => (window as any).__ffmpegbReady === true || (window as any).__ffmpegbError !== undefined,
      { timeout: 60000 }
    );
    const initError = await this.page.evaluate(() => (window as any).__ffmpegbError);
    if (initError) {
      throw new Error("Browser init failed: " + initError);
    }

    console.log("Loading ffmpeg.wasm core (~31 MB)...");
    await this.page.evaluate(() => (window as any).__ffmpegb.load());
    this.loaded = true;
    console.log("ffmpeg.wasm core loaded.");
  }

  /**
   * Copies a local file into the browser's virtual filesystem.
   */
  async writeFile(virtualPath: string, localPath: string): Promise<void> {
    if (!this.page) throw new Error("Client not launched");
    const data = await Bun.file(localPath).arrayBuffer();
    const base64 = encodeBase64(new Uint8Array(data));
    await this.page.evaluate(
      ({ path, base64 }: { path: string; base64: string }) =>
        (window as any).__ffmpegb.writeFile(path, base64),
      { path: virtualPath, base64 }
    );
  }

  /**
   * Copies data from the browser's virtual filesystem to a local file.
   */
  async readFile(virtualPath: string, localPath: string): Promise<void> {
    if (!this.page) throw new Error("Client not launched");
    const base64: string = await this.page.evaluate(
      (path: string) => (window as any).__ffmpegb.readFile(path),
      virtualPath
    );
    await Bun.write(localPath, decodeBase64(base64));
  }

  /**
   * Reads a text file from the browser's virtual filesystem.
   */
  async readTextFile(virtualPath: string): Promise<string> {
    if (!this.page) throw new Error("Client not launched");
    return await this.page.evaluate(
      (path: string) => (window as any).__ffmpegb.readFile(path, "utf8"),
      virtualPath
    );
  }

  /**
   * Executes an ffmpeg command inside the browser.
   */
  async exec(...args: string[]): Promise<ExecResult> {
    if (!this.page) throw new Error("Client not launched");
    return await this.page.evaluate(
      (cmdArgs: string[]) => (window as any).__ffmpegb.exec(cmdArgs),
      args
    );
  }

  /**
   * Lists a directory in the browser's virtual filesystem.
   */
  async listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    if (!this.page) throw new Error("Client not launched");
    return await this.page.evaluate(
      (dirPath: string) => (window as any).__ffmpegb.listDir(dirPath),
      path
    );
  }

  /**
   * Deletes a file in the browser's virtual filesystem.
   */
  async deleteFile(path: string): Promise<void> {
    if (!this.page) throw new Error("Client not launched");
    await this.page.evaluate(
      (filePath: string) => (window as any).__ffmpegb.deleteFile(filePath),
      path
    );
  }

  /**
   * Shuts down the browser and local server.
   */
  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
      this.page = undefined;
      this.loaded = false;
    }
    if (this.server) {
      this.server.stop();
      this.server = undefined;
    }
  }
}
