import type { Clock } from '../ports';

/** A Clock that only moves when the test says so. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  set(date: Date): void {
    this.current = date.getTime();
  }
}
