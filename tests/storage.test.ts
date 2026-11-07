import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStorage } from "../server/storage.js";
test("文件按内容去重，重复写入保持原件，读取核验指纹与大小", async () => {
  const root = await mkdtemp(join(tmpdir(), "sales-storage-test-"));
  try {
    const s = new LocalFileStorage(root),
      bytes = Buffer.from("合成验证文件");
    const [a, b] = await Promise.all([
      s.put("documents", bytes),
      s.put("documents", bytes),
    ]);
    assert.equal(a.key, b.key);
    assert.deepEqual(await s.get(a.key, a.sha256, a.size), bytes);
    await assert.rejects(() => s.get(a.key, a.sha256, a.size + 1), /异常/);
    await writeFile(join(root, a.key), "损坏文件");
    await assert.rejects(() => s.get(a.key, a.sha256, a.size), /异常/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("拒绝路径穿越、符号链接及缺失原文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "sales-storage-security-"));
  try {
    const s = new LocalFileStorage(root),
      file = await s.put("artifacts", Buffer.from("sample"));
    await assert.rejects(() => s.get("../secret", file.sha256), /异常|无效/);
    await rm(join(root, file.key));
    await symlink("/etc/hosts", join(root, file.key));
    await assert.rejects(() => s.get(file.key, file.sha256), /异常/);
    await rm(join(root, file.key));
    await assert.rejects(() => s.get(file.key, file.sha256), /异常/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
