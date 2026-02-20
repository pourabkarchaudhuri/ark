/**
 * Renderer-side analytics helpers.
 * Delegates to the main process via the preload bridge (Measurement Protocol).
 */

export function trackEvent(name: string, params?: Record<string, string | number | boolean>): void {
  window.analytics?.trackEvent(name, params);
}

export function trackPageView(page: string): void {
  window.analytics?.trackPageView(page);
}
