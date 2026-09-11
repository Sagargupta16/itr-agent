import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The suite runs in well under a second locally, but GitHub's Windows
    // runners stall for seconds at a time (Defender scanning node_modules,
    // cold JIT), and vitest's 5s default then fails whichever trivial
    // synchronous test happened to be executing. The one test that measures
    // performance (the hostile-label AIS case) asserts its own elapsed time
    // inline, so a longer outer timeout does not weaken it.
    testTimeout: 30_000,
  },
});
