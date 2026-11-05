/**
 * Single-instance helper (kept free of `electron` imports so it is unit testable).
 * A second instance that did not get the lock must quit before ready: otherwise it runs
 * boot-health (counting the first instance's pending boot as a crash), the AI router and
 * the quit finalizers (which rewrite the shared chat file from a stale snapshot).
 * The chat-prompts test runner is allowed to run without the lock.
 */
export function isLosingInstance(gotTheLock: boolean, isChatPromptsTest: boolean): boolean {
  return !gotTheLock && !isChatPromptsTest;
}
