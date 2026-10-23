/**
 * Oracle engine version. Bump whenever a release changes what Oracle ranks or
 * how it scores, so results cached by an older engine are discarded instead
 * of being served for up to the 15-minute cache TTL.
 *
 *   1 — v1.0.75 baseline (scoring unchanged from v1.0.74; cache field introduced)
 *   2 — v1.0.76 graph + cluster layers made real (neighbour-based graph signal, main-thread clusters)
 *   3 — v1.0.77 ML layer repaired (continuous probabilities, rank-normalised, evidence-based user profile)
 */
export const ORACLE_ENGINE_VERSION = 3;
