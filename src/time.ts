// ============================================================
// 时间工具
//
// 约定：
//   - 数据库 *_at 列存人可直接读的本地时间字符串：YYYY-MM-DD HH:MM:ss.SSS
//   - 数据库 *_ts 列存 Unix 毫秒时间戳（整数），用于范围检索
// ============================================================

/** 把 Date / 毫秒时间戳 格式化为本地可读字符串 YYYY-MM-DD HH:MM:ss.SSS */
export function fmtLocalTs(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d;
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' +
    p(date.getMonth() + 1) + '-' +
    p(date.getDate()) + ' ' +
    p(date.getHours()) + ':' +
    p(date.getMinutes()) + ':' +
    p(date.getSeconds()) + '.' +
    String(date.getMilliseconds()).padStart(3, '0')
  );
}

/** 当前时间：本地可读字符串 */
export function nowReadable(): string {
  return fmtLocalTs(Date.now());
}

/** 当前时间：Unix 毫秒时间戳 */
export function nowTs(): number {
  return Date.now();
}
