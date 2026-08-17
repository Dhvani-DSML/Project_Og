import { loadConfig, validateConfig } from "./config";

export function connectDB() {
  const cfg = loadConfig();
  validateConfig(cfg);
  return { connected: true, url: cfg.dbUrl };
}

export class ConnectionPool {
  open() {
    return connectDB();
  }
}
