import "dotenv/config";
import mysql, { type PoolConnection } from "mysql2/promise";
export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DB,
  ssl:
    process.env.MYSQL_SSL === "true" ? { rejectUnauthorized: true } : undefined,
  connectionLimit: 8,
  connectTimeout: 5000,
  charset: "utf8mb4",
  timezone: "Z",
  multipleStatements: false,
});
export async function rows(
  sql: string,
  args: any[] = [],
  db: Pick<PoolConnection, "execute"> = pool,
): Promise<any[]> {
  const [r] = await db.execute(sql, args);
  return r as any[];
}
export async function tx<T>(fn: (c: PoolConnection) => Promise<T>) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
export const parse = (x: any) => (typeof x === "string" ? JSON.parse(x) : x);
