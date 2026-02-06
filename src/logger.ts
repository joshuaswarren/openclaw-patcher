interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

const PREFIX = "[patcher]";

let _logger: Logger | null = null;
let _debug = false;

export function initLogger(logger: Logger, debug: boolean): void {
  _logger = logger;
  _debug = debug;
}

export const log = {
  info(msg: string, ...args: unknown[]) {
    if (_logger) _logger.info(`${PREFIX} ${msg}`, ...args);
    else console.log(`${PREFIX} ${msg}`, ...args);
  },
  warn(msg: string, ...args: unknown[]) {
    if (_logger) _logger.warn(`${PREFIX} ${msg}`, ...args);
    else console.warn(`${PREFIX} ${msg}`, ...args);
  },
  error(msg: string, ...args: unknown[]) {
    if (_logger) _logger.error(`${PREFIX} ${msg}`, ...args);
    else console.error(`${PREFIX} ${msg}`, ...args);
  },
  debug(msg: string, ...args: unknown[]) {
    if (!_debug) return;
    if (_logger) _logger.debug(`${PREFIX} ${msg}`, ...args);
    else console.log(`${PREFIX} [debug] ${msg}`, ...args);
  },
};
