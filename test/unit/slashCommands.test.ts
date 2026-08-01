import { describe, expect, it } from "vitest";
import {
  buildHelpText,
  buildUnknownCommandText,
  dispatchSlash,
} from "../../src/ui/slashCommands.js";
import type { Skill } from "../../src/skills/loader.js";

const skills: Skill[] = [
  { name: "commit", description: "生成提交", body: "提交技能指令体" },
  { name: "help", description: "与内置命令同名的技能", body: "同名技能体" },
];

describe("dispatchSlash", () => {
  it("内置命令优先于同名技能", () => {
    const result = dispatchSlash("/help", skills);
    expect(result).toEqual({ kind: "builtin", command: "help", args: "" });
  });

  it("四个内置命令都识别为 builtin", () => {
    for (const cmd of ["help", "clear", "compact", "exit"] as const) {
      expect(dispatchSlash(`/${cmd}`, skills).kind).toBe("builtin");
    }
  });

  it("命中技能且无参数：消息即技能 body", () => {
    const result = dispatchSlash("/commit", skills);
    expect(result.kind).toBe("skill");
    if (result.kind !== "skill") throw new Error("unreachable");
    expect(result.skill.name).toBe("commit");
    expect(result.message).toBe("提交技能指令体");
  });

  it("命中技能带参数：body + 用户附加参数段", () => {
    const result = dispatchSlash("/commit fix 登录 bug", skills);
    expect(result.kind).toBe("skill");
    if (result.kind !== "skill") throw new Error("unreachable");
    expect(result.message).toBe("提交技能指令体\n\n用户附加参数: fix 登录 bug");
  });

  it("内置命令带参数时 args 被解析出来", () => {
    const result = dispatchSlash("/compact now", skills);
    expect(result).toEqual({ kind: "builtin", command: "compact", args: "now" });
  });

  it("未命中内置命令与技能时返回 unknown", () => {
    const result = dispatchSlash("/nope 参数", skills);
    expect(result).toEqual({ kind: "unknown", command: "nope" });
  });

  it("技能列表为空时非内置命令一律 unknown", () => {
    expect(dispatchSlash("/commit", []).kind).toBe("unknown");
  });
});

describe("/help 文本", () => {
  it("列出内置命令与技能（name — description），无 T5 占位", () => {
    const text = buildHelpText(skills);
    for (const cmd of ["/help", "/clear", "/compact", "/exit"]) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain("/commit — 生成提交");
    expect(text).not.toContain("T5");
  });

  it("技能为空时提示技能目录位置", () => {
    const text = buildHelpText([]);
    expect(text).toContain("暂无已加载技能");
    expect(text).toContain(".xharness/skills");
  });
});

describe("未知命令提示", () => {
  it("有技能时列出可用技能", () => {
    const text = buildUnknownCommandText("nope", skills);
    expect(text).toContain("未知命令: /nope");
    expect(text).toContain("/commit");
  });

  it("无技能时提示 /help", () => {
    const text = buildUnknownCommandText("nope", []);
    expect(text).toContain("未知命令: /nope");
    expect(text).toContain("/help");
  });
});
