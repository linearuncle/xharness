import type { Message } from "../types/messages.js";

export const INTERRUPT_MARKER = "[回合被用户中断]";

export function estimateTokens(messages: Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export class History {
  private readonly messages: Message[] = [];

  push(message: Message): void {
    this.messages.push(message);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  estimateTokens(): number {
    return estimateTokens(this.messages);
  }

  replaceAll(messages: Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
  }

  appendInterruptMarker(): void {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: INTERRUPT_MARKER }],
    });
  }
}
