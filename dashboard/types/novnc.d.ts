declare module '@novnc/novnc' {
  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: {
        credentials?: { password?: string };
        wsProtocols?: string[];
      }
    );
    scaleViewport: boolean;
    resizeSession: boolean;
    addEventListener(type: 'connect' | 'disconnect' | 'credentialsrequired' | string, handler: () => void): void;
    sendCredentials(credentials: { password: string }): void;
    disconnect(): void;
  }
}
