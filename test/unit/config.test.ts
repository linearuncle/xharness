import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("缺少 ANTHROPIC_API_KEY 时抛出带提示的错误", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(() => loadConfig()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("默认值正确：端点、模型与 deepseek-v4-* 的 1M 上下文窗口", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    vi.stubEnv("XHARNESS_MODEL", "");
    vi.stubEnv("XHARNESS_CONTEXT_WINDOW", "");
    const config = loadConfig();
    expect(config.apiKey).toBe("test-key");
    expect(config.baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(config.model).toBe("deepseek-v4-pro");
    expect(config.contextWindow).toBe(1_000_000);
  });

  it("未知模型默认 200K 上下文窗口", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("XHARNESS_MODEL", "some-unknown-model");
    vi.stubEnv("XHARNESS_CONTEXT_WINDOW", "");
    const config = loadConfig();
    expect(config.contextWindow).toBe(200_000);
  });

  it("XHARNESS_CONTEXT_WINDOW 覆盖默认值，非法值抛错", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("XHARNESS_CONTEXT_WINDOW", "123456");
    expect(loadConfig().contextWindow).toBe(123456);

    vi.stubEnv("XHARNESS_CONTEXT_WINDOW", "not-a-number");
    expect(() => loadConfig()).toThrow(/XHARNESS_CONTEXT_WINDOW/);
  });
});
