import type { AppEvent } from "../shared/types";

type Listener = (event: AppEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: Omit<AppEvent, "at">): void {
  const full: AppEvent = { ...event, at: Date.now() };
  for (const listener of listeners) {
    try {
      listener(full);
    } catch {
      // a broken SSE client must not break the writer
    }
  }
}
