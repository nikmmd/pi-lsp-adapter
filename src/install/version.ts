export interface ServerVersionSpec {
  serverId: string;
  version?: string;
}

export function parseServerVersionSpec(input: string): ServerVersionSpec {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("Expected a server id, for example pyright or pyright@1.1.405.");
  }

  const atIndex = trimmed.indexOf("@");
  const serverId = atIndex === -1 ? trimmed : trimmed.slice(0, atIndex);
  const version = atIndex === -1 ? undefined : trimmed.slice(atIndex + 1);

  validateServerId(serverId);

  if (version !== undefined) {
    if (version.length === 0 || version.includes("@") || /\s/u.test(version)) {
      throw new Error(`Invalid version in server spec: ${input}`);
    }
    return { serverId, version };
  }

  return { serverId };
}

function validateServerId(serverId: string): void {
  if (serverId.length === 0) {
    throw new Error("Server id cannot be empty.");
  }

  if (/\s/u.test(serverId)) {
    throw new Error(`Server id cannot contain whitespace: ${serverId}`);
  }

  if (serverId.includes("/")) {
    throw new Error(`Server id cannot contain '/': ${serverId}`);
  }
}
