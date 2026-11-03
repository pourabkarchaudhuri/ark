/**
 * Native Bridge (Phase 3 — optional Rust sidecar)
 *
 * Loads the `ark-native` napi addon (built from `native/ark-native/`) and
 * exposes its exports through a safe, always-available surface. If the
 * native module fails to load for any reason (missing binary, wrong
 * platform/arch, corrupted install, antivirus quarantine), every export
 * degrades to `null` rather than throwing — callers must treat a `null`
 * result the same as "native path unavailable, use the JS/PowerShell
 * fallback", never crash the app over it.
 *
 * `session_enumerate()` replaces the tasklist + PowerShell subprocess pair
 * in `session-tracker.ts` with a single native syscall-based process
 * enumeration (see `native/ark-native/src/lib.rs` for the full rationale).
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { logger } from './safe-logger.js';

export interface NativeProcessInfo {
  pid: number;
  /** Full executable path, lowercased. `undefined` when unresolvable. */
  path?: string;
  /**
   * Image basename (Toolhelp32 `szExeFile`), lowercased. Present even when
   * `path` is not; absent from binaries built before 1.0.97.
   */
  name?: string;
}

interface ArkNativeModule {
  sessionEnumerate: () => NativeProcessInfo[];
  /** Added in 1.0.97; absent from older binaries. */
  jobAssignKillOnClose?: (pid: number) => boolean;
}

let _native: ArkNativeModule | null = null;
let _loadAttempted = false;
let _loadError: string | null = null;

// Platform/arch-specific filename produced by `napi build` — Ark ships
// Windows x64 only today (matches every other native module in this repo:
// usearch, onnxruntime-node, sharp). Two levels up from the compiled output
// at dist-electron/electron/native-bridge.js reaches the project root's
// native/ark-native/ directory (dev) — in a packaged build the same
// relative path resolves into app.asar.unpacked via Electron's transparent
// asar-unpack redirect (see asarUnpack in package.json's build config).
// Extracted to its own overridable function (rather than inlined in
// `loadNative`) purely so tests can point it at a nonexistent path to
// exercise the failure branch without needing to mock `createRequire`
// itself.
let _requireNativeModule: () => unknown = () =>
  require('../../native/ark-native/ark-native.win32-x64-msvc.node');

function loadNative(): ArkNativeModule | null {
  if (_loadAttempted) return _native;
  _loadAttempted = true;
  try {
    const mod = _requireNativeModule();
    if (typeof (mod as ArkNativeModule)?.sessionEnumerate !== 'function') {
      throw new Error('ark-native loaded but sessionEnumerate export is missing');
    }
    _native = mod as ArkNativeModule;
    logger.log('[NativeBridge] ark-native loaded successfully');
  } catch (err) {
    _loadError = err instanceof Error ? err.message : String(err);
    logger.warn(`[NativeBridge] ark-native failed to load, falling back to JS/PowerShell path: ${_loadError}`);
    _native = null;
  }
  return _native;
}

/**
 * Test-only seam: reset the cached load state and optionally override the
 * module loader, so tests can exercise both the success and failure
 * branches deterministically. Never called from production code.
 */
export function __resetNativeBridgeForTests(loader?: () => unknown): void {
  _loadAttempted = false;
  _native = null;
  _loadError = null;
  if (loader) _requireNativeModule = loader;
}

/**
 * Native process enumeration (PID + resolved full path when available).
 * Returns `null` if the native module isn't loaded — callers must fall back
 * to the existing tasklist/PowerShell snapshot in that case, exactly as if
 * this function didn't exist.
 */
export function nativeSessionEnumerate(): NativeProcessInfo[] | null {
  const native = loadNative();
  if (!native) return null;
  try {
    return native.sessionEnumerate();
  } catch (err) {
    logger.warn('[NativeBridge] sessionEnumerate call failed, falling back:', err);
    return null;
  }
}

/**
 * Put a child process (a built-in llama-server) into Ark's kill-on-close Windows job object, so
 * Windows kills it when Ark exits for any reason, a crash included. Returns false when the native
 * module or the job is unavailable; the caller keeps its own kill-on-quit as the fallback.
 */
export function nativeJobAssignKillOnClose(pid: number): boolean {
  const native = loadNative();
  if (!native || typeof native.jobAssignKillOnClose !== 'function') return false;
  try {
    return native.jobAssignKillOnClose(pid) === true;
  } catch (err) {
    logger.warn('[NativeBridge] jobAssignKillOnClose failed:', err);
    return false;
  }
}

/** Diagnostic status for the debug/settings surface (`window.debug.nativeBridgeStatus()`). */
export function nativeBridgeStatus(): { nativeAvailable: boolean; source: string; error?: string } {
  const native = loadNative();
  return native
    ? { nativeAvailable: true, source: 'ark-native' }
    : { nativeAvailable: false, source: 'js-fallback', error: _loadError ?? undefined };
}
