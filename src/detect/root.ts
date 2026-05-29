import { access } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

export interface RootDetectionResult {
  rootDir: string;
  marker: string;
  markerPath: string;
}

export async function detectRoot(filePath: string, rootMarkers: string[]): Promise<RootDetectionResult | undefined> {
  let currentDir = dirname(resolve(filePath));
  const filesystemRoot = parse(currentDir).root;

  while (true) {
    for (const marker of rootMarkers) {
      const markerPath = join(currentDir, ...marker.split(/[\\/]+/));
      if (await pathExists(markerPath)) {
        return {
          rootDir: currentDir,
          marker,
          markerPath,
        };
      }
    }

    if (currentDir === filesystemRoot) {
      return undefined;
    }

    currentDir = dirname(currentDir);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
