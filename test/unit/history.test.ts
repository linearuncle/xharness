import { describe, expect, it } from "vitest";
import {
  History,
  INTERRUPT_MARKER,
  estimateTokens,
} from "../../src/session/history.js";
import type { Message } from "../../src/types/messages.js";

describe("History", () => {
  it("push 与 getMessages", () => {
    const history = new History();
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    history.push(message);
    expect(history.getMessages()).toEqual([message]);
  });

  it("estimateTokens 为 JSON 字符数/4 向上取整", () => {
    const history = new History();
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "hello world" }],
    };
    history.push(message);
    const expected = Math.ceil(JSON.stringify([message]).length / 4);
    expect(history.estimateTokens()).toBe(expected);
    expect(estimateTokens([message])).toBe(expected);
  });

  it("空历史 estimateTokens 也不报错", () => {
    expect(new History().estimateTokens()).toBe(Math.ceil("[]".length / 4));
  });

  it("appendInterruptMarker 追加中断标记 user 消息", () => {
    const history = new History();
    history.push({ role: "user", content: [{ type: "text", text: "task" }] });
    history.appendInterruptMarker();
    const last = history.getMessages().at(-1)!;
    expect(last).toEqual({
      role: "user",
      content: [{ type: "text", text: INTERRUPT_MARKER }],
    });
  });
});
