export { };

type CordovaRequire = (moduleId: string) => unknown;

interface CordovaNamespace {
    require?: CordovaRequire;
}

declare global {
    interface Window {
        cordova?: CordovaNamespace;
        nodejs?: {
            channel: {
                send: (message: unknown) => void;
                on: (event: 'message', callback: (message: unknown) => void) => void;
            };
            start: (scriptName: string, message?: unknown) => void;
        };
    }
}
