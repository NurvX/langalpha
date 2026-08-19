/**
 * Bridge to the Electron desktop shell, injected by its preload script.
 *
 * Undefined in every browser build, so treat desktop as an enhancement and keep
 * the browser path alive at each call site. The shell updates on its own slow
 * cadence while this app deploys continuously, so a new web build must never
 * require a new shell: feature-detect each method, never the version.
 *
 * Nothing here touches auth. The shell intercepts the OAuth authorize navigation
 * itself and hands the code back through this app's own /callback route, so
 * sign-in needs no desktop-specific code on this side.
 */
export interface DesktopBridge {
  readonly version: string;
  /** Node's process.platform: 'darwin' | 'win32' | 'linux'. */
  readonly platform: string;
  /**
   * Whether the shell hid this window's titlebar. Absent before shell 0.1.1.
   *
   * Per window, not per platform: the same install opens a frameless main
   * window and a framed account window, and a first launch is framed on macOS
   * too. Only the shell knows.
   */
  readonly windowChrome?: 'hidden' | 'native';
  /** Tells the shell which theme the page settled on. Added in shell 0.1.0. */
  setTheme?(theme: 'light' | 'dark'): void;
  openExternal?(url: string): Promise<void>;
}

declare global {
  interface Window {
    langalphaDesktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined =
  typeof window === 'undefined' ? undefined : window.langalphaDesktop;
