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
    // Only this repo's own suite. Vitest's default glob also collects test
    // files under .claude/worktrees/, where Claude Code keeps session
    // checkouts of other commits: one leftover worktree made `pnpm test` run a
    // stale copy of every test beside the real ones (302 instead of 151).
    include: ["tests/**/*.test.ts"],
  },
});
