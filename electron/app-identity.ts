/**
 * Windows app identity.
 *
 * The AppUserModelId the running app sets must equal package.json build.appId: electron-builder
 * stamps that id on the NSIS Start-menu/desktop shortcuts, and Windows groups taskbar buttons and
 * routes toasts by it. A mismatch drops or mislabels toasts (updater, Ark Wrapped) and shows a
 * pinned shortcut and the running window as two taskbar icons. build.appId itself must not change:
 * it is the NSIS uninstall key and the updater identity. A unit test keeps the two in sync.
 */
export const APP_USER_MODEL_ID = 'com.ark.app';
