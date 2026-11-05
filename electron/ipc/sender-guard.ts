/**
 * Who may call a privileged IPC channel (1.0.98 F3).
 *
 * `event.sender` is the whole window; any frame inside it (an embedded page, an iframe in rendered
 * chat content) shares it. A privileged handler (keys, connectors, anything that reaches the
 * network on the user's behalf) therefore also checks `event.senderFrame`: it must be the top frame
 * of the app's own main window. Free of `electron` imports so it is unit tested.
 */
export interface FrameLike {
  parent?: unknown | null;
  routingId?: number;
  processId?: number;
}

export interface SenderEventLike {
  sender?: { id?: number; mainFrame?: FrameLike | null } | null;
  senderFrame?: FrameLike | null;
}

export interface MainWindowLike {
  webContents?: { id?: number; mainFrame?: FrameLike | null; isDestroyed?: () => boolean } | null;
  isDestroyed?: () => boolean;
}

export function isMainAppFrame(event: SenderEventLike | null | undefined, mainWindow: MainWindowLike | null | undefined): boolean {
  try {
    const wc = mainWindow?.webContents;
    if (!wc || mainWindow?.isDestroyed?.() || wc.isDestroyed?.()) return false;
    const sender = event?.sender;
    const frame = event?.senderFrame;
    if (!sender || !frame) return false;
    if (typeof sender.id === 'number' && typeof wc.id === 'number' && sender.id !== wc.id) return false;
    const top = wc.mainFrame ?? sender.mainFrame;
    if (top) return frame === top || (frame.routingId === top.routingId && frame.processId === top.processId && frame.routingId !== undefined);
    return frame.parent === null || frame.parent === undefined;
  } catch {
    return false;
  }
}
