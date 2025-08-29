/**
 * Simple logging utility for Womptron
 * Provides structured logging with different levels
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
}

export interface Logger {
  error: (message: string, ...args: any[]) => void;
  warn: (message: string, ...args: any[]) => void;
  info: (message: string, ...args: any[]) => void;
  debug: (message: string, ...args: any[]) => void;
}

class WomptronLogger implements Logger {
  private logLevel: LogLevel;

  constructor(logLevel: LogLevel = LogLevel.INFO) {
    this.logLevel = logLevel;
  }

  private log(
    level: LogLevel,
    levelName: string,
    message: string,
    ...args: any[]
  ) {
    if (level <= this.logLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${levelName}] [Womptron]`;

      if (args.length > 0) {
        // eslint-disable-next-line no-console
        console.log(prefix, message, ...args);
      } else {
        // eslint-disable-next-line no-console
        console.log(prefix, message);
      }
    }
  }

  error(message: string, ...args: any[]) {
    this.log(LogLevel.ERROR, 'ERROR', message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.log(LogLevel.WARN, 'WARN', message, ...args);
  }

  info(message: string, ...args: any[]) {
    this.log(LogLevel.INFO, 'INFO', message, ...args);
  }

  debug(message: string, ...args: any[]) {
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
