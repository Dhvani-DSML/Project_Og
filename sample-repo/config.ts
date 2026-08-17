export function loadConfig() {
  return { port: 3000, dbUrl: "postgres://localhost" };
}

export function validateConfig(cfg: { port: number }) {
  if (cfg.port < 0) throw new Error("bad port");
  return true;
}
