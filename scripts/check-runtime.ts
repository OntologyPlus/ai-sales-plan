import {pool,rows} from "../server/db.js";
// Run from a separate process/scheduler: a stalled Worker must not monitor itself.
const issues:string[]=[];
const report:any={checkedAt:new Date().toISOString(),scope:"local-runtime-check",professionalQualityVerified:false,restoreDrillVerified:false,providerBillReconciled:false};
try{
  const origin=process.env.APP_ORIGIN||"http://127.0.0.1:3200";
  try{const response=await fetch(origin,{method:"HEAD",redirect:"error",signal:AbortSignal.timeout(5000)});report.httpStatus=response.status;if(!response.ok)issues.push("应用HTTP不可用");}catch{issues.push("应用HTTP连接失败或超时");}
  const [migration]=await rows("SELECT MAX(version) AS version FROM sp_migrations");report.migration=migration.version;if(migration.version<10)issues.push("数据库未完成迁移10");
  const [queue]=await rows("SELECT SUM(status='queued') AS queued,SUM(status='running') AS running,SUM(status='running' AND (lease_until IS NULL OR lease_until<UTC_TIMESTAMP(3))) AS expiredLease,SUM(status='queued' AND created_at<DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 120 SECOND)) AS overdueQueued,COALESCE(SUM(model_requests),0) AS persistedModelRequests FROM sp_workspace_runs");report.agent=queue;
  if(Number(queue.expiredLease)>0)issues.push("Agent执行租约已过期，需检查Worker或恢复状态");
  if(Number(queue.overdueQueued)>0)issues.push("Agent排队超过120秒，需检查Worker和队列积压");
  report.issues=issues;report.passed=issues.length===0;
  // Quiet on unchanged healthy state. Scheduling/alerts are owned by deployment operations.
  if(process.argv.includes("--report")||issues.length)console.log(JSON.stringify(report,null,2));
  if(issues.length)process.exitCode=1;
}catch(e){console.error(JSON.stringify({passed:false,error:(e as any).code||"runtime-check-failed"}));process.exitCode=1;}
finally{await pool.end();}
