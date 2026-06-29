/**
 * Spaced repetition (FSRS via ts-fsrs) and review-ordering primitives.
 * Operates on the Card shape defined in decks.ts (imported as a type only, so
 * there is no runtime dependency cycle).
 */
import { fsrs, generatorParameters, createEmptyCard, Rating, type Card as FsrsCard } from "ts-fsrs";
import type { Card, FsrsState } from "./decks.js";

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Fisher-Yates shuffle (returns a new array). */
export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Day-scale scheduling for a once-a-day study loop: no short same-day learning steps.
const scheduler = fsrs(
  generatorParameters({ enable_fuzz: false, learning_steps: [], relearning_steps: [] }),
);

/** Reconstruct a ts-fsrs Card from stored state, or a fresh one. */
function toFsrsCard(card: Card, now: Date): FsrsCard {
  const s = card.srs;
  if (!s) return createEmptyCard(now);
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    reps: s.reps,
    lapses: s.lapses,
    learning_steps: s.learning_steps,
    state: s.state,
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  } as FsrsCard;
}

/** Apply one review result with FSRS, returning a NEW card with updated schedule. */
export function schedule(card: Card, correct: boolean): Card {
  const now = new Date();
  const { card: next } = scheduler.next(
    toFsrsCard(card, now),
    now,
    correct ? Rating.Good : Rating.Again,
  );
  const srs: FsrsState = {
    due: next.due.toISOString(),
    stability: Math.round(next.stability * 1000) / 1000,
    difficulty: Math.round(next.difficulty * 1000) / 1000,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    reps: next.reps,
    lapses: next.lapses,
    learning_steps: next.learning_steps,
    state: next.state,
    last_review: next.last_review ? next.last_review.toISOString() : now.toISOString(),
  };
  return { front: card.front, back: card.back, due: next.due.toISOString().slice(0, 10), srs };
}

/** Due/new counts for a set of cards. */
export function counts(cards: Card[]): { dueCount: number; newCount: number } {
  const today = todayISO();
  return {
    dueCount: cards.filter((c) => c.due && c.due <= today).length,
    newCount: cards.filter((c) => !c.due).length,
  };
}
