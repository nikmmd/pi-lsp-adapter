export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MissingEnvironmentVariableError extends ConfigError {
  constructor(variableName: string, field?: string) {
    super(
      field
        ? `Missing environment variable ${variableName} referenced by ${field}.`
        : `Missing environment variable ${variableName}.`,
    );
  }
}

export class MissingBinaryError extends ConfigError {
  constructor(serverId: string, command: string) {
    super(`${serverId} binary not found: ${command}`);
  }
}
