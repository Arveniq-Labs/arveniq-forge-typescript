import { ForgeMobileClient, type ForgeMobileClientOptions, type MobileCredentialProvider } from '@arveniq/forge-mobile-core';

/** Structural subset of Capacitor Preferences. Inject the real plugin from the app. */
export interface CapacitorPreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

/** Structural subset of Capacitor App lifecycle support. */
export interface CapacitorAppLike {
  addListener(eventName: 'appStateChange', listener: (state: { isActive: boolean }) => void): Promise<{ remove(): Promise<void> }> | { remove(): Promise<void> };
}

export class CapacitorTokenStore implements MobileCredentialProvider {
  constructor(private readonly preferences: CapacitorPreferencesLike, private readonly key = 'arveniq.forge.mobile.access-token') {}

  async getAccessToken(): Promise<string | null> {
    return (await this.preferences.get({ key: this.key })).value;
  }

  saveAccessToken(value: string): Promise<void> {
    return this.preferences.set({ key: this.key, value });
  }

  clearAccessToken(): Promise<void> {
    return this.preferences.remove({ key: this.key });
  }
}

export interface CapacitorForgeClientOptions extends Omit<ForgeMobileClientOptions, 'credentialProvider'> {
  preferences: CapacitorPreferencesLike;
  tokenKey?: string;
}

export function createCapacitorForgeClient(options: CapacitorForgeClientOptions): ForgeMobileClient {
  return new ForgeMobileClient({
    ...options,
    credentialProvider: new CapacitorTokenStore(options.preferences, options.tokenKey),
  });
}

/** Resumes only caller-owned persisted streams after a real inactive-to-active transition. */
export class CapacitorLifecycleController {
  #listener?: { remove(): Promise<void> };
  #wasInactive = false;

  constructor(private readonly onForeground: () => void | Promise<void>) {}

  async attach(app: CapacitorAppLike): Promise<() => Promise<void>> {
    await this.detach();
    this.#listener = await app.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) this.#wasInactive = true;
      if (isActive && this.#wasInactive) {
        this.#wasInactive = false;
        void this.onForeground();
      }
    });
    return () => this.detach();
  }

  async detach(): Promise<void> {
    await this.#listener?.remove();
    this.#listener = undefined;
  }
}
