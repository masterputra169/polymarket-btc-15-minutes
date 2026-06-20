import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Include both frontend (src/) and bot (bot/) tests
    include: [
      'src/**/__tests__/**/*.test.{ts,tsx}',
      'bot/**/__tests__/**/*.test.ts',
      'bot/tests/**/*.test.ts',
    ],
  },
});
