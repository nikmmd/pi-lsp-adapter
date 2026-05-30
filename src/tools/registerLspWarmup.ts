import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { LspExtensionState } from "../state.js";
import { setLspStatusLine } from "../statusLine.js";

export type GetLspWarmupState = () => LspExtensionState | null;

export function registerLspWarmup(pi: ExtensionAPI, getState: GetLspWarmupState): void {
  pi.on("tool_call", (event, ctx) => {
    const state = getState();
    if (!state?.config.warmup) return;
    if (!isToolCallEventType("read", event)) return;

    const filePath = event.input.path;
    if (typeof filePath !== "string" || filePath.length === 0) return;

    const warmupState = state;
    void warmupState.runtimeManager
      .warmupFile(filePath)
      .then((warmed) => {
        if (warmed && getState() === warmupState) setLspStatusLine(ctx, warmupState);
      })
      .catch(() => undefined);
  });
}
