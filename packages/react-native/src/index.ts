import { ForgeMobileClient, type ForgeMobileClientOptions, type MobileCredentialProvider } from '@arveniq/forge-mobile-core';

/** Implement with Keychain, Keystore, or another platform-backed secure store. */
export interface SecureMobileTokenStore {
  getAccessToken(): Promise<string | null>;
}

/** Small adapter so this package does not force a React Native runtime import. */
export interface AppLifecycleAdapter {
  subscribe(listener: (state: 'active' | 'background' | 'inactive') => void): () => void;
}

export interface ReactNativeForgeClientOptions extends Omit<ForgeMobileClientOptions, 'credentialProvider'> {
  tokenStore: SecureMobileTokenStore;
}

export function createReactNativeForgeClient(options: ReactNativeForgeClientOptions): ForgeMobileClient {
  const credentialProvider: MobileCredentialProvider = {
    getAccessToken: () => options.tokenStore.getAccessToken(),
  };
  return new ForgeMobileClient({ ...options, credentialProvider });
}

/**
 * Coordinates app lifecycle with a caller-owned stream-resume strategy. No message is resent
 * automatically; the app must resume with the persisted turn and last event identifier.
 */
export class MobileLifecycleController {
  #unsubscribe?: () => void;
  #background = false;

  constructor(private readonly onForeground: () => void | Promise<void>) {}

  attach(lifecycle: AppLifecycleAdapter): () => void {
    this.detach();
    this.#unsubscribe = lifecycle.subscribe((state) => {
      if (state === 'background' || state === 'inactive') this.#background = true;
      if (state === 'active' && this.#background) {
        this.#background = false;
        void this.onForeground();
      }
    });
    return () => this.detach();
  }

  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }
}
