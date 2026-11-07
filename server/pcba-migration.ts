import { rows } from "./db.js";

export async function migratePcbaProfiles(db: any) {
  const [parent] = await rows("SELECT CHARACTER_SET_NAME AS charsetName,COLLATION_NAME AS collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sp_proposals' AND COLUMN_NAME='id'", [], db);
  if (!parent || !/^[a-zA-Z0-9_]+$/.test(parent.charsetName) || !/^[a-zA-Z0-9_]+$/.test(parent.collationName))
    throw new Error("无法确认方案主键的字符集/排序规则，停止新增PCBA表");
  const id = `CHAR(36) CHARACTER SET ${parent.charsetName} COLLATE ${parent.collationName}`;
  await db.execute(`CREATE TABLE IF NOT EXISTS sp_pcba_profiles (
    proposal_id ${id} NOT NULL, edition INT NOT NULL, revision INT NOT NULL,
    profile JSON NOT NULL, updated_by ${id} NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(proposal_id,edition), FOREIGN KEY(proposal_id) REFERENCES sp_proposals(id))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sp_pcba_profile_versions (
    proposal_id ${id} NOT NULL, edition INT NOT NULL, revision INT NOT NULL,
    profile JSON NOT NULL, request_id CHAR(36) NOT NULL, request_hash CHAR(64) NOT NULL,
    actor_id ${id} NOT NULL, proposal_revision INT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(proposal_id,edition,revision), UNIQUE(proposal_id,edition,request_id),
    FOREIGN KEY(proposal_id) REFERENCES sp_proposals(id))`);
  await db.execute("INSERT IGNORE INTO sp_migrations(version) VALUES (8)");
}
