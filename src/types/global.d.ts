export {};

declare global {
  interface Window {
    nodejs?: {
      channel: {
        send: (message: unknown) => void;
  on: (event: 'message', callback: (message: unknown) => void) => void;
      };
      start: (scriptName: string, message?: unknown) => void;
    };
  }
}
