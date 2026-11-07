import { rows, pool } from "../server/db.js";
import { storedFile } from "../server/storage.js";
try {
  let count = 0;
  for (const table of ["sp_document_versions", "sp_artifacts"]) {
    const records = await rows(
      `SELECT id,storage_provider,storage_key,byte_size,sha256 FROM ${table}`,
    );
    for (const row of records) {
      await storedFile(row);
      count++;
    }
    console.log(table + ": " + records.length + "个文件引用已核验");
  }
  const blobs = await rows(
    "SELECT TABLE_NAME,COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('sp_document_versions','sp_artifacts') AND DATA_TYPE LIKE '%blob%'",
  );
  if (blobs.length) throw new Error("仍存在文件BLOB字段");
  console.log("文件引用校验通过，共" + count + "个；原件及成果表无BLOB字段。");
} catch (e: any) {
  console.error("文件核验失败：", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
