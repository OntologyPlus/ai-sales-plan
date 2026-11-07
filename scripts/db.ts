import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pool, rows, tx } from "../server/db.js";
import { passwordHash } from "../server/security.js";
import { migrateFileStorage } from "../server/storage-migration.js";
import { migratePcbaProfiles } from "../server/pcba-migration.js";
import { migrateWorkspace } from "../server/workspace-migration.js";
import { migrateProject } from "../server/project-migration.js";
try {
  const mode = process.argv[2];
  const [info] = await rows("SELECT VERSION() AS version, DATABASE() AS db");
  console.log("数据库检查：", info);
  if (mode === "check") {
    const tables = await rows("SHOW TABLES LIKE 'sp_%'");
    console.log("本项目表数量：", tables.length);
  } else if (mode === "migrate") {
    await tx(async (db) => {
      const [locks]: any = await db.execute(
        "SELECT GET_LOCK(?,10) AS acquired",
        ["sales_plan_migrations"],
      );
      if (Number(locks[0].acquired) !== 1)
        throw new Error("无法获得迁移锁，请稍后重试");
      try {
        const sql = await readFile(
          new URL("../server/schema.sql", import.meta.url),
          "utf8",
        );
        for (const stmt of sql
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean))
          await db.execute(stmt);
        for (const [table, name, definition] of [
          ["sp_templates", "family_id", "CHAR(36) NULL"],
          ["sp_templates", "version", "INT NOT NULL DEFAULT 1"],
          ["sp_risks", "evidence", "JSON NULL"],
        ]) {
          const [found]: any = await db.execute(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?",
            [table, name],
          );
          if (!found.length)
            await db.execute(
              `ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`,
            );
        }
        await db.execute(
          "UPDATE sp_templates SET family_id=id WHERE family_id IS NULL",
        );
        await db.execute(
          "ALTER TABLE sp_templates MODIFY family_id CHAR(36) NOT NULL",
        );
        await db.execute(
          "INSERT IGNORE INTO sp_migrations(version) VALUES (7)",
        );
        await migrateFileStorage(db);
        await migratePcbaProfiles(db);
        await migrateWorkspace(db);
        await migrateProject(db);
        await db.execute(
          "INSERT IGNORE INTO sp_migrations(version) VALUES (1),(2),(3),(4),(5)",
        );
      } finally {
        await db.execute("SELECT RELEASE_LOCK(?)", ["sales_plan_migrations"]);
      }
    });
    console.log("迁移10完成（可重复执行，MySQL DDL按语句生效）");
  } else if (mode === "bootstrap") {
    const password = process.env.BOOTSTRAP_PASSWORD;
    if (!password || password.length < 12)
      throw new Error("请配置至少12位的BOOTSTRAP_PASSWORD");
    const email = process.env.BOOTSTRAP_EMAIL || "admin@example.test";
    const existing = await rows("SELECT id FROM sp_users WHERE email=?", [
      email,
    ]);
    if (existing.length) console.log("账号已存在，未覆盖");
    else {
      await pool.execute(
        "INSERT INTO sp_users(id,email,name,password_hash,roles) VALUES (?,?,?,?,?)",
        [
          randomUUID(),
          email,
          process.env.BOOTSTRAP_NAME || "系统管理员",
          passwordHash(password),
          JSON.stringify(["admin"]),
        ],
      );
      console.log("管理员已创建：", email);
    }
  } else throw new Error("使用check、migrate或bootstrap");
} catch (e: any) {
  console.error("数据库操作失败：", e.code || e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
