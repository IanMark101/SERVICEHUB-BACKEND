type LogLevel = "info" | "warn" | "error";

interface LogContext {
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  code?: string;
  error?: unknown;
  [key: string]: unknown;
}

function normalizeError(error: unknown) {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    ...(typeof (error as Error & { code?: unknown }).code === "string"
      ? { code: (error as Error & { code: string }).code }
      : {}),
  };
}

function write(level: LogLevel, message: string, context: LogContext = {}) {
  const payload = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
    ...(context.error !== undefined ? { error: normalizeError(context.error) } : {}),
  });

  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
};
