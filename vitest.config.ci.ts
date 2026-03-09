import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/zeromq_transport.test.ts',
      'test/test_cluster.test.ts',
      'test/fault_injection.test.ts',
      'test/cookie_rotation.test.ts',
    ],
    benchmark: {
      include: ['benchmark/**/*.bench.ts'],
    },
  },
});
