const debugOn = () => process.env.OBSIDIAN_MCP_LOG === 'debug';

export const log = {
  debug: (...args: unknown[]) => { if (debugOn()) console.error(...args); },
  info: (...args: unknown[]) => console.error(...args),
  warn: (...args: unknown[]) => console.error(...args),
  error: (...args: unknown[]) => console.error(...args),
};
