import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

interface VendorAsset {
  relativePath: string;
  data: string;
}

let materialized: Promise<string> | undefined;

async function copyAsset(relativePath: string, base64: string, targetPath: string): Promise<void> {
  if (existsSync(targetPath)) return;
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, Buffer.from(base64, "base64"));
}

export async function materializeEmbeddedVendor(): Promise<string> {
  materialized ??= (async () => {
    const { vendorAssetBuildId, vendorAssets } = await import("./generated/vendor-assets.js") as {
      vendorAssetBuildId: string;
      vendorAssets: readonly VendorAsset[];
    };
    const dir = join(tmpdir(), `ffmpegb-${process.versions.bun}-${vendorAssetBuildId}`);
    await Promise.all(vendorAssets.map(({ relativePath, data }) => copyAsset(relativePath, data, join(dir, relativePath))));
    return dir;
  })();
  return materialized;
}
