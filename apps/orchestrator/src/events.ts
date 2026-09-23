import { EventEmitter } from "node:events";
import type { RuntimeStore } from "@epm/spec-io";

export interface ControlEvent {
  id: number;
  type: "plan" | "execution" | "approval" | "test" | "integration" | "system";
  goalId?: string;
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export class EventBus {
  readonly emitter = new EventEmitter();
  readonly history: ControlEvent[];
  #nextId = 1;

  constructor(readonly store?: RuntimeStore) {
    this.history = (store?.eventsSince(0) ?? []).map((event) => ({
      id: event.seq, type: event.type as ControlEvent["type"], at: event.createdAt,
      goalId: typeof event.payload.goalId === "string" ? event.payload.goalId : undefined,
      message: String(event.payload.message ?? event.type), data: event.payload.data as Record<string, unknown> | undefined
    }));
    this.#nextId = (this.history.at(-1)?.id ?? 0) + 1;
  }

  emit(event: Omit<ControlEvent, "id" | "at">): ControlEvent {
    const at = new Date().toISOString();
    const storedId = this.store?.recordEvent(event.type, { goalId: event.goalId, message: event.message, data: event.data }, at);
    const full = { ...event, id: storedId ?? this.#nextId++, at };
    this.#nextId = Math.max(this.#nextId, full.id + 1);
    this.history.push(full);
    if (this.history.length > 500) this.history.shift();
    this.emitter.emit("event", full);
    return full;
  }

  since(id = 0) { return this.history.filter((event) => event.id > id); }
}
