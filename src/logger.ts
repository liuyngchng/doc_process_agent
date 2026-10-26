import pino from 'pino';
import { join } from 'node:path';

let logger: pino.Logger;

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
    // fallback：未初始化时输出到 stdout
    logger = pino({ level: 'info' });
  }
  return logger;
}
