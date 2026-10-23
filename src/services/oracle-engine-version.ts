/**
 * Oracle engine version. Bump whenever a release changes what Oracle ranks or
 * how it scores, so results cached by an older engine are discarded instead
 * of being served for up to the 15-minute cache TTL.
 *
 *   1 — v1.0.75 baseline (scoring unchanged from v1.0.74; cache field introduced)
 */
export const ORACLE_ENGINE_VERSION = 1;
