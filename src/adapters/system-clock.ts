import type { Clock } from '@/core';

export const systemClock: Clock = {
  now: () => new Date(),
};
