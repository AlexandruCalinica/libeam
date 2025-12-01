// src/logger.ts

export type LogLevel = "debug" | "info" | "warn" | "error" | "none";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 4,
};

export interface LogContext {
  nodeId?: string;
  component?: string;
  actorId?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  context: LogContext;
  timestamp: Date;
  error?: Error;
}

export type LogHandler = (entry: LogEntry) => void;

/**
 * Default console log handler that formats entries for terminal output.
 */
export const consoleLogHandler: LogHandler = (entry: LogEntry) => {
  const { level, message, context, timestamp, error } = entry;
  const ts = timestamp.toISOString();
  const ctx = Object.entries(context)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  const prefix = ctx ? `[${ctx}]` : "";
  const formatted = `${ts} ${level.toUpperCase().padEnd(5)} ${prefix} ${message}`;

  switch (level) {
    case "debug":
      console.debug(formatted);
      break;
    case "info":
      console.log(formatted);
      break;
    case "warn":
      console.warn(formatted);
      break;
    case "error":
      console.error(formatted);
      if (error) {
        console.error(error);
      }
      break;
  }
};

/**
 * Global logger configuration.
 */
class LoggerConfig {
  private _level: LogLevel = "info";
  private _handler: LogHandler = consoleLogHandler;

  get level(): LogLevel {
    return this._level;
  }

  set level(level: LogLevel) {
    this._level = level;
  }

  get handler(): LogHandler {
    return this._handler;
  }

  set handler(handler: LogHandler) {
    this._handler = handler;
  }

  /**
   * Configure the global logger.
   */
  configure(options: { level?: LogLevel; handler?: LogHandler }): void {
    if (options.level !== undefined) {
      this._level = options.level;
    }
    if (options.handler !== undefined) {
      this._handler = options.handler;
    }
  }
}

export const loggerConfig = new LoggerConfig();

/**
 * A structured logger with context.
 */
export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  /**
   * Creates a child logger with additional context.
   */
  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.context, ...additionalContext });
  }

  private log(
    level: LogLevel,
    message: string,
    extra?: LogContext & { error?: Error },
  ): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[loggerConfig.level]) {
      return;
    }

    const { error, ...extraContext } = extra || {};
    const entry: LogEntry = {
      level,
      message,
      context: { ...this.context, ...extraContext },
      timestamp: new Date(),
      error,
    };

    loggerConfig.handler(entry);
  }

  debug(message: string, extra?: LogContext): void {
    this.log("debug", message, extra);
  }

  info(message: string, extra?: LogContext): void {
    this.log("info", message, extra);
  }

  warn(message: string, extra?: LogContext): void {
    this.log("warn", message, extra);
  }

  error(message: string, error?: Error, extra?: LogContext): void {
    this.log("error", message, { ...extra, error } as LogContext & {
      error?: Error;
    });
  }
}

/**
 * Creates a logger for a specific component.
 */
export function createLogger(component: string, nodeId?: string): Logger {
  return new Logger({ component, nodeId });
}
