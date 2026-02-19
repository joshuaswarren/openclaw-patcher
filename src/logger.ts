import util from "node:util";

interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?: (message: string) => void;
}

const PREFIX = "[patcher]";

let _logger: Logger | null = null;
let _debug = false;

export function initLogger(logger: Logger, debug: boolean): void {
  _logger = logger;
  _debug = debug;
}

function formatMessage(msg: string, args: unknown[]): string {
  if (args.length === 0) return `${PREFIX} ${msg}`;
  const suffix = args
    .map((arg) => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 4, breakLength: 120 })))
    .join(" ");
  return `${PREFIX} ${msg} ${suffix}`;
}

export const log = {
  info(msg: string, ...args: unknown[]) {
    if (_logger) _logger.info(formatMessage(msg, args));
    else console.log(`${PREFIX} ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    if (_logger) _logger.warn(formatMessage(msg, args));
    else console.warn(`${PREFIX} ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    if (_logger) _logger.error(formatMessage(msg, args));
    else console.error(`${PREFIX} ${msg}`, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (!_debug) return;
    if (_logger?.debug) _logger.debug(formatMessage(msg, args));
    else console.log(`${PREFIX} [debug] ${msg}`, ...args);
  },
};
