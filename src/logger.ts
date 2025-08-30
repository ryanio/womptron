/**
 * Simple logging utility for Womptron
 * Provides structured logging with different levels
 */

export const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export type Logger = {
  error: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
};

class WomptronLogger implements Logger {
  private readonly logLevel: LogLevel;

  constructor(logLevel: LogLevel = LogLevel.INFO) {
    this.logLevel = logLevel;
  }

  private log(
    level: LogLevel,
    levelName: string,
    message: string,
    ...args: unknown[]
  ) {
    if (level <= this.logLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `${timestamp} [${levelName}] [Womptron]`;

      if (args.length > 0) {
        process.stdout.write(`${prefix} ${message} ${JSON.stringify(args)}\n`);
      } else {
        process.stdout.write(`${prefix} ${message}\n`);
      }
    }
  }

  error(message: string, ...args: unknown[]) {
    this.log(LogLevel.ERROR, 'ERROR', message, ...args);
  }

  warn(message: string, ...args: unknown[]) {
    this.log(LogLevel.WARN, 'WARN', message, ...args);
  }

  info(message: string, ...args: unknown[]) {
    this.log(LogLevel.INFO, 'INFO', message, ...args);
  }

  debug(message: string, ...args: unknown[]) {
    this.log(LogLevel.DEBUG, 'DEBUG', message, ...args);
  }
}

// Create and export a default logger instance
const getLogLevel = (): LogLevel => {
  const level = process.env.LOG_LEVEL?.toUpperCase();
  switch (level) {
    case 'ERROR':
      return LogLevel.ERROR;
    case 'WARN':
      return LogLevel.WARN;
    case 'INFO':
      return LogLevel.INFO;
    case 'DEBUG':
      return LogLevel.DEBUG;
    default:
      return LogLevel.INFO;
  }
};

export const logger = new WomptronLogger(getLogLevel());
