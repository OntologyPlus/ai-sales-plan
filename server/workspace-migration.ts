import { rows } from "./db.js";
export async function migrateWorkspace(db: any) {
  const [parent] = await rows("SELECT CHARACTER_SET_NAME AS charsetName,COLLATION_NAME AS collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sp_proposals' AND COLUMN_NAME='id'", [], db);
  if (!parent || !/^[a-zA-Z0-9_]+$/.test(parent.charsetName) || !/^[a-zA-Z0-9_]+$/.test(parent.collationName)) throw new Error("无法确认方案主键字符集");
  const id = `CHAR(36) CHARACTER SET ${parent.charsetName} COLLATE ${parent.collationName}`;
  await db.execute(`CREATE TABLE IF NOT EXISTS sp_workspace_runs (
    id ${id} PRIMARY KEY, proposal_id ${id} NOT NULL, requested_by ${id} NOT NULL,
    request_key CHAR(36) NOT NULL, request_hash CHAR(64) NOT NULL, input_snapshot JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'queued', result_json JSON NULL, usage_json JSON NULL,
    error_message VARCHAR(500) NULL, cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
    lease_owner CHAR(36) NULL, lease_until DATETIME(3) NULL, model_requests INT NOT NULL DEFAULT 0,
    apply_hash CHAR(64) NULL, applied_revision INT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), started_at DATETIME(3) NULL,
    finished_at DATETIME(3) NULL, applied_at DATETIME(3) NULL,
    UNIQUE(proposal_id,request_key), INDEX(status,lease_until),
    FOREIGN KEY(proposal_id) REFERENCES sp_proposals(id))`);
  await db.execute(`CREATE TABLE IF NOT EXISTS sp_workspace_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, run_id ${id} NOT NULL, type VARCHAR(30) NOT NULL,
    payload JSON NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX(run_id,id), FOREIGN KEY(run_id) REFERENCES sp_workspace_runs(id))`);
  await db.execute("INSERT IGNORE INTO sp_migrations(version) VALUES (9)");
}
