import { rows } from "./db.js";
export async function migrateProject(db:any) {
  const [p]=await rows("SELECT CHARACTER_SET_NAME AS cs,COLLATION_NAME AS co FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='sp_proposals' AND COLUMN_NAME='id'",[],db);
  if(!p||!/^[a-zA-Z0-9_]+$/.test(p.cs)||!/^[a-zA-Z0-9_]+$/.test(p.co))throw new Error("无法确认方案主键字符集");
  const id=`CHAR(36) CHARACTER SET ${p.cs} COLLATE ${p.co}`;
  for(const sql of [
    `CREATE TABLE IF NOT EXISTS sp_project_controls(proposal_id ${id} NOT NULL,edition INT NOT NULL,revision INT NOT NULL DEFAULT 0,finance_id ${id} NULL,quality_id ${id} NULL,legal_id ${id} NULL,PRIMARY KEY(proposal_id,edition),FOREIGN KEY(proposal_id) REFERENCES sp_proposals(id))`,
    `CREATE TABLE IF NOT EXISTS sp_project_records(id ${id} PRIMARY KEY,proposal_id ${id} NOT NULL,edition INT NOT NULL,kind VARCHAR(30) NOT NULL,revision INT NOT NULL,data JSON NOT NULL,dependencies JSON NOT NULL,status VARCHAR(20) NOT NULL DEFAULT 'candidate',created_by ${id} NOT NULL,confirmed_by ${id} NULL,created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),INDEX(proposal_id,edition),FOREIGN KEY(proposal_id) REFERENCES sp_proposals(id))`,
    `CREATE TABLE IF NOT EXISTS sp_project_versions(id BIGINT AUTO_INCREMENT PRIMARY KEY,record_id ${id} NOT NULL,revision INT NOT NULL,snapshot JSON NOT NULL,actor_id ${id} NOT NULL,created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE(record_id,revision),FOREIGN KEY(record_id) REFERENCES sp_project_records(id))`,
    `CREATE TABLE IF NOT EXISTS sp_project_receipts(proposal_id ${id} NOT NULL,request_id CHAR(36) NOT NULL,request_hash CHAR(64) NOT NULL,actor_id ${id} NOT NULL,result JSON NOT NULL,PRIMARY KEY(proposal_id,request_id))`,
    `CREATE TABLE IF NOT EXISTS sp_project_events(id BIGINT AUTO_INCREMENT PRIMARY KEY,proposal_id ${id} NOT NULL,edition INT NOT NULL,type VARCHAR(40) NOT NULL,payload JSON NOT NULL,resolved BOOLEAN NOT NULL DEFAULT FALSE,created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),INDEX(proposal_id,edition))`,
    `CREATE TABLE IF NOT EXISTS sp_deliveries(id ${id} PRIMARY KEY,proposal_id ${id} NOT NULL,approval_id ${id} NOT NULL,request_id CHAR(36) NOT NULL,recipient VARCHAR(240) NOT NULL,channel VARCHAR(100) NOT NULL,delivered_at DATETIME(3) NOT NULL,artifact_hash CHAR(64) NOT NULL,note TEXT NOT NULL,actor_id ${id} NOT NULL,created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),UNIQUE(proposal_id,request_id),FOREIGN KEY(approval_id) REFERENCES sp_approval_requests(id))`,
  ])await db.execute(sql);
  await db.execute("INSERT IGNORE INTO sp_migrations(version) VALUES (10)");
}
