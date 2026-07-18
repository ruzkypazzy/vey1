// Simple structured logger that writes JSON lines to stdout.

type LogLevel = "info" | "warn" | "error" | "debug";

function emit(level: LogLevel, fields: Record<string, unknown>, msg: string) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, ...fields, msg });
  if (level === "error") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const logger = {
  info: (fields: Record<string, unknown>, msg: string) => emit("info", fields, msg),
  warn: (fields: Record<string, unknown>, msg: string) => emit("warn", fields, msg),
  error: (fields: Record<string, unknown>, msg: string) => emit("error", fields, msg),
  debug: (fields: Record<string, unknown>, msg: string) => emit("debug", fields, msg),
};
