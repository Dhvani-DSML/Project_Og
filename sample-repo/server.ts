import { connectDB } from "./db";
import { ConnectionPool } from "./db";

function startServer() {
  const db = connectDB();
  const pool = new ConnectionPool();
  pool.open();
  return db;
}

export const bootstrap = () => {
  startServer();
};
