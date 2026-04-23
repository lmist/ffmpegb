/**
 * Browser-side HTML page for ffmpegb.
 * This page is served from a local Bun HTTP server so that
 * all scripts are same-origin and Web Workers are allowed.
 */

export const BROWSER_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
</head>
<body>
<script type="module">
  try {
    const { FFmpeg } = await import("/ffmpeg/index.js");
    const { toBlobURL } = await import("/util/index.js");

    const ffmpeg = new FFmpeg();
    let loaded = false;

    ffmpeg.on("log", ({ type, message }) => {
      if (window.__ffmpegb_onLog) window.__ffmpegb_onLog({ type, message });
    });

    window.__ffmpegb = {
      async load() {
        const baseURL = "/core";
        await ffmpeg.load({
          coreURL: await toBlobURL(baseURL + "/core.js", "text/javascript"),
          wasmURL: await toBlobURL(baseURL + "/core.wasm", "application/wasm"),
        });
        loaded = true;
        return true;
      },

      async writeFile(name, dataBase64) {
        if (!loaded) throw new Error("ffmpeg not loaded");
        const data = Uint8Array.from(atob(dataBase64), c => c.charCodeAt(0));
        await ffmpeg.writeFile(name, data);
        return true;
      },

      async readFile(name, encoding = "binary") {
        if (!loaded) throw new Error("ffmpeg not loaded");
        const opts = encoding === "utf8" ? { encoding: "utf8" } : undefined;
        const data = await ffmpeg.readFile(name, opts);
        if (data instanceof Uint8Array) {
          const chunkSize = 0x8000;
          let binary = "";
          for (let i = 0; i < data.byteLength; i += chunkSize) {
            binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
          }
          return btoa(binary);
        }
        return data;
      },

      async exec(args) {
        if (!loaded) throw new Error("ffmpeg not loaded");
        const logs = [];
        const cb = ({ type, message }) => logs.push({ type, message });
        ffmpeg.on("log", cb);
        try {
          const exitCode = await ffmpeg.exec(args);
          return { exitCode, logs };
        } finally {
          ffmpeg.off("log", cb);
        }
      },

      async listDir(path) {
        if (!loaded) throw new Error("ffmpeg not loaded");
        return await ffmpeg.listDir(path);
      },

      async deleteFile(name) {
        if (!loaded) throw new Error("ffmpeg not loaded");
        await ffmpeg.deleteFile(name);
        return true;
      },
    };

    window.__ffmpegbReady = true;
  } catch (err) {
    window.__ffmpegbError = err.toString();
    console.error("ffmpegb init error:", err);
  }
</script>
</body>
</html>
`;
