import { rows } from "./db.js";
import { storage } from "./storage.js";
import { hash } from "./security.js";
export async function migrateFileStorage(db: any) {
  for (const [table, legacy, kind] of [
    ["sp_document_versions", "original", "documents"],
    ["sp_artifacts", "bytes", "artifacts"],
  ] as const) {
    const columns = await rows(
      "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
      [table],
      db,
    );
    const names = new Set(columns.map((c) => c.name));
    for (const [name, type] of [
      ["storage_provider", "VARCHAR(20) NULL"],
      ["storage_key", "VARCHAR(200) NULL"],
      ["byte_size", "BIGINT UNSIGNED NULL"],
    ])
      if (!names.has(name))
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    if (names.has(legacy)) {
      const ids = await rows(`SELECT id FROM ${table}`, [], db);
      for (const { id } of ids) {
        const [row] = await rows(`SELECT * FROM ${table} WHERE id=?`, [id], db);
        if (!row.storage_key) {
          if (!Buffer.isBuffer(row[legacy]) || hash(row[legacy]) !== row.sha256)
            throw new Error(`${table}存在损坏的旧文件，迁移已停止，原字段保留`);
          const file = await storage.put(kind, row[legacy]);
          await db.execute(
            `UPDATE ${table} SET storage_provider=?,storage_key=?,byte_size=? WHERE id=?`,
            [file.provider, file.key, file.size, id],
          );
        }
      }
      // Verify every referenced original before dropping any legacy payload column.
      for (const { id } of ids) {
        const [row] = await rows(`SELECT * FROM ${table} WHERE id=?`, [id], db);
        if (row.storage_provider !== "local") throw new Error("存储后端不匹配");
        await storage.get(row.storage_key, row.sha256, Number(row.byte_size));
        if (row[legacy] && hash(row[legacy]) !== row.sha256)
          throw new Error("旧文件与新存储不一致");
      }
      await db.execute(`ALTER TABLE ${table} DROP COLUMN ${legacy}`);
    }
    await db.execute(
      `ALTER TABLE ${table} MODIFY storage_provider VARCHAR(20) NOT NULL, MODIFY storage_key VARCHAR(200) NOT NULL, MODIFY byte_size BIGINT UNSIGNED NOT NULL`,
    );
  }
  await db.execute("INSERT IGNORE INTO sp_migrations(version) VALUES (6)");
}
