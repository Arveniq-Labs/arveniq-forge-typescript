import UIComponent from 'sap/ui/core/UIComponent';
import App from 'sap/m/App';
import type Control from 'sap/ui/core/Control';
import { ForgeChatGatewayClient } from 'arveniq/forge/sapui5/index';
import { createChatPage, type ChatPanelHandle } from 'arveniq/forge/sapui5/ui5';

/** @namespace arveniq.forge.sample */
export default class Component extends UIComponent {
  static metadata = { manifest: 'json' };
  private chat?: ChatPanelHandle;
  createContent(): Control {
    const uri = this.getManifestEntry('/sap.app/dataSources/chatGateway/uri') as string;
    const baseUrl = this.getManifestObject().resolveUri(uri);
    const gateway = new ForgeChatGatewayClient({ baseUrl,
      csrfTokenProvider: async () => {
        const response = await fetch(baseUrl.replace(/\/$/, '') + '/csrf', {
          credentials: 'same-origin', redirect: 'error', headers: { 'X-CSRF-Token': 'Fetch' },
        });
        const token = response.headers.get('X-CSRF-Token');
        if (!response.ok || !token) throw new Error('Unable to obtain a CSRF token. Sign in to your application.');
        return token;
      },
    });
    const chat = createChatPage({ gateway }); this.chat = chat;
    return new App({ pages: [chat.page], autoFocus: false });
  }
  exit() { this.chat?.destroy(); this.chat = undefined; }
}
