/**
 * stderr-only logger. stdout belongs to the JSON-RPC transport; nothing else
 * may ever write to it. console.log/info/debug are rebound to stderr as a
 * last line of defence against stray prints in third-party code.
 */
const write = (level: string, msg: string, extra?: unknown): void => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra === undefined ? {} : { extra }) });
  process.stderr.write(line + "\n");
};

export const log = {
  debug: (msg: string, extra?: unknown) => write("debug", msg, extra),
  info: (msg: string, extra?: unknown) => write("info", msg, extra),
  warn: (msg: string, extra?: unknown) => write("warn", msg, extra),
  error: (msg: string, extra?: unknown) => write("error", msg, extra),
};

export function protectStdout(): void {
  const toStderr = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
}
