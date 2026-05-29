import type { LoadLspConfigResult } from "./config/loadConfig.js";
import type { LspInstallManager } from "./install/manager.js";
import type { LspProcessRegistry } from "./lsp/processRegistry.js";
import type { LspRuntimeManager } from "./lsp/runtimeManager.js";
import type { LspResultCache } from "./tools/resultCache.js";

export interface LspExtensionState {
  ownerId: string;
  cwd: string;
  config: LoadLspConfigResult;
  installManager: LspInstallManager;
  processRegistry: LspProcessRegistry;
  runtimeManager: LspRuntimeManager;
  resultCache: LspResultCache;
  lastRecovery?: {
    terminated: number;
    removed: number;
    kept: number;
  };
}
