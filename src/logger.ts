import pino from 'pino';
import { join } from 'node:path';

let logger: pino.Logger;

// 初始化前的占位 logger（info 级别、仅 stdout）。
// 各模块在 import 阶段就会执行 `const log = getLogger()`，此时 initLogger 尚未运行；
// 直接返回这个 fallback 会导致模块永远持有 fallback，拿不到之后重建的 logger。
const fallback = pino({ level: 'info' });

// 通过 Proxy 把每次方法调用转发给“当前”的 logger，
// 因此模块顶层持有的 log 引用在 initLogger() 重建后依然指向新实例。
function createLazyLogger(): pino.Logger {
  return new Proxy(fallback, {
    get(target, prop) {
      const actual = logger ?? target;
      const value = Reflect.get(actual, prop, actual);
      if (typeof value === 'function') {
        return value.bind(actual);
      }
      return value;
    },
  }) as pino.Logger;
}

export function initLogger(dataDir: string, debug = false) {
  const level = debug ? 'debug' : 'info';
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino/file',
      options: { destination: join(dataDir, 'logs', 'app.log'), mkdir: true },
      level,
    },
    {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:yyyy-mm-dd HH:MM:ss' },
      level,
    },
  ];

  logger = pino(
    { level },
    pino.transport({ targets }),
  );
  return logger;
}

export function getLogger(): pino.Logger {
  if (!logger) {
    // 尚未初始化：返回懒代理，后续 initLogger 生效后自动指向新实例
    logger = createLazyLogger();
  }
  return logger;
}
