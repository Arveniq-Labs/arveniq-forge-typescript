import { createReactNativeForgeClient, type ReactNativeForgeClientOptions, type SecureMobileTokenStore } from '@arveniq/forge-react-native';

/** Structural subset of expo-secure-store used by this package; inject the real module from the app. */
export interface ExpoSecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export class ExpoSecureTokenStore implements SecureMobileTokenStore {
  constructor(private readonly secureStore: ExpoSecureStoreLike, private readonly key = 'arveniq.forge.mobile.access-token') {}

  getAccessToken(): Promise<string | null> {
    return this.secureStore.getItemAsync(this.key);
  }

  saveAccessToken(token: string): Promise<void> {
    return this.secureStore.setItemAsync(this.key, token);
  }

  clearAccessToken(): Promise<void> {
    return this.secureStore.deleteItemAsync(this.key);
  }
}

export function createExpoForgeClient(options: Omit<ReactNativeForgeClientOptions, 'tokenStore'> & { secureStore: ExpoSecureStoreLike; tokenKey?: string }) {
  return createReactNativeForgeClient({
    ...options,
    tokenStore: new ExpoSecureTokenStore(options.secureStore, options.tokenKey),
  });
}
