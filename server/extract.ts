import { Worker } from "node:worker_threads";
import { ApiError } from "./security.js";
let active = 0;
export function extract(
  filename: string,
  bytes: Buffer,
): Promise<{ text: string; notes: string[] }> {
  if (!/\.(txt|md|csv|docx|pdf)$/i.test(filename))
    throw new ApiError(422, "支持TXT、Markdown、CSV、DOCX、可读取文本的PDF");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024)
    throw new ApiError(413, "文件须为1字节至5MB");
  if (active >= 2) throw new ApiError(429, "解析繁忙，请稍后重试");
  active++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new Worker(new URL("./extract-worker.mjs", import.meta.url), {
      workerData: { filename, bytes },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const done = (err?: Error, result?: any) => {
      if (settled) return;
      settled = true;
      active--;
      clearTimeout(timer);
      void w.terminate();
      err ? reject(err) : resolve(result);
    };
    const timer = setTimeout(
      () => done(new ApiError(422, "解析超过20秒，请拆分文件")),
      20000,
    );
    w.once("message", (m) =>
      done(m.error ? new ApiError(422, m.error) : undefined, m),
    );
    w.once("error", () => done(new ApiError(422, "解析失败或超出资源限制")));
    w.once("exit", () => done(new ApiError(422, "解析未完成")));
  });
}
