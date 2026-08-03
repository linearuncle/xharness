import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

/**
 * gui/store.js 在 import 时读取 XH_DATA_DIR，故每个用例用独立目录 + 动态 import。
 * 缓存破坏：query 加时间戳，避免 vitest 复用旧模块态。
 */
async function loadStore(dataDir: string) {
  process.env.XH_DATA_DIR = dataDir;
  const href = pathToFileURL(join(process.cwd(), "gui/store.js")).href;
  return import(`${href}?t=${Date.now()}-${Math.random()}`);
}

describe("sidebar 对话按 updatedAt 降序", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "xh-store-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("新建对话排在最前；有新内容的旧对话会上浮", async () => {
    const store = await loadStore(dataDir);
    store.load();
    store.addProject("/tmp/proj-a");

    const older = store.newConversation("/tmp/proj-a");
    // 保证时间戳可区分
    await new Promise((r) => setTimeout(r, 5));
    const newer = store.newConversation("/tmp/proj-a");

    let ids = store.sidebarData().projects[0].conversations.map((c: { id: string }) => c.id);
    expect(ids[0]).toBe(newer);
    expect(ids[1]).toBe(older);

    await new Promise((r) => setTimeout(r, 5));
    store.appendBlock(older, { kind: "user", text: "旧对话新消息" });

    ids = store.sidebarData().projects[0].conversations.map((c: { id: string }) => c.id);
    expect(ids[0]).toBe(older);
    expect(ids[1]).toBe(newer);
  });

  it("重放时从末条事件 ts 恢复 updatedAt", async () => {
    const store = await loadStore(dataDir);
    store.load();
    store.addProject("/tmp/proj-b");
    const a = store.newConversation("/tmp/proj-b");
    await new Promise((r) => setTimeout(r, 5));
    const b = store.newConversation("/tmp/proj-b");
    await new Promise((r) => setTimeout(r, 5));
    store.appendBlock(a, { kind: "user", text: "touch a" });

    // 同模块再次 load = 启动重放路径（不依赖二次动态 import）
    store.load();
    const ids = store.sidebarData().projects[0].conversations.map((c: { id: string }) => c.id);
    expect(ids[0]).toBe(a);
    expect(ids[1]).toBe(b);
    const convs = store.sidebarData().projects[0].conversations;
    expect(convs[0].updatedAt).toBeGreaterThan(convs[1].updatedAt);
  });
});
