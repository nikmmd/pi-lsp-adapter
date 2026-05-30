import { dirname, join, parse, resolve } from "node:path";
import { pathExists } from "../util/helpers.js";

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
