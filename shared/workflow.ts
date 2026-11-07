export const roles = [
  "engineer",
  "chemist",
  "compliance",
  "leader",
  "admin",
  "finance",
  "quality",
  "legal",
] as const;
export type Role = (typeof roles)[number];
export const roleLabels: Record<Role, string> = {
  engineer: "售前应用工程师",
  chemist: "应用化学师",
  compliance: "合规专员",
  leader: "审批领导",
  admin: "管理员",
  finance: "财务审核",
  quality: "供应与质量",
  legal: "法务审核",
};
export const statusLabels: Record<string, string> = {
  DRAFT: "草稿",
  IN_REVIEW: "审核中",
  CHANGES_REQUESTED: "退回修改",
  REJECTED: "已驳回",
  APPROVED: "已批准",
  ARCHIVED: "已归档",
};
export const sections = [
  "客户应用场景理解",
  "性能约束与应用边界",
  "产品推荐与匹配依据",
  "与现有方案或竞品对比",
  "样品测试与验证建议",
  "安全、合规声明与风险说明",
];
export function validateReviewers(
  owner: string,
  creator: string,
  assignments: Record<string, string>,
  users: { id: string; roles: string[]; active: number | boolean }[],
) {
  const ids = Object.values(assignments);
  if (ids.length !== 3 || ids.some((x) => !x) || new Set(ids).size !== 3)
    throw new Error("技术、合规与终审须分配三位不同审核人");
  for (const role of ["chemist", "compliance", "leader"]) {
    const id = assignments[role];
    const u = users.find((x) => x.id === id);
    if (id === owner || id === creator)
      throw new Error("方案创建人及负责人不能审批自己的方案");
    if (!u?.active || !u.roles.includes(role))
      throw new Error("审核人未启用或不具备对应角色");
  }
}
export function mayDecide(
  steps: { role: string; status: string }[],
  role: string,
) {
  if(!["finance","leader"].includes(role))return true;
  const required=["chemist","compliance",...steps.filter(s=>["quality","legal"].includes(s.role)).map(s=>s.role),...(role==="leader"&&steps.some(s=>s.role==="finance")?["finance"]:[])];
  return required.every(r=>steps.some(s=>s.role===r&&s.status==="approved"));
}

export const jobLabels: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "待人工采用",
  failed: "执行失败",
  cancelled: "已取消",
  applied: "已采用",
};
