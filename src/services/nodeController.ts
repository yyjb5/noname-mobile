type NodeMessage = {
    type: string;
    payload?: Record<string, unknown>;
};

type Listener = (message: NodeMessage) => void;

const BRIDGE_TIMEOUT_MS = 15000;
const BRIDGE_POLL_INTERVAL_MS = 100;

class NodeController {
    private started = false;
    private listeners = new Set<Listener>();
    private bridgePromise: Promise<NonNullable<typeof window.nodejs>> | null = null;
    private startPromise: Promise<void> | null = null;
    constructor() {
        if (typeof window !== 'undefined') {
            window.__nonameNodeController = this;
        }
    }

    async ensureStarted(): Promise<void> {
        if (this.started) {
            return;
        }
        if (this.startPromise) {
            return this.startPromise;
        }
        this.startPromise = this.startInternal().catch((error) => {
            this.startPromise = null;
            throw error;
        });
        await this.startPromise;
    }

    async send(message: NodeMessage): Promise<void> {
        const bridge = await this.resolveBridge();
        this.debug('send', message);
        bridge.channel.send(message);
    }

    on(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private async startInternal(): Promise<void> {
        const bridge = await this.resolveBridge();
        this.debug('bridge ready, starting main.js');
        bridge.channel.on('message', (raw: unknown) => {
            this.debug('incoming raw', raw);
            const message = this.normalizeIncoming(raw);
            this.debug('incoming normalized', message);
            if (!message) {
                return;
            }
            this.listeners.forEach((listener) => {
                try {
                    listener(message);
                } catch (err) {
                    console.error('Node listener error', err);
                }
            });
        });
        bridge.start('main.js');
        this.started = true;
    }

    private async resolveBridge(): Promise<NonNullable<typeof window.nodejs>> {
        const existing = this.acquireBridge();
        if (existing) {
            this.debug('bridge already available');
            return existing;
        }
        if (!this.bridgePromise) {
            this.bridgePromise = this.waitForBridge().catch((error) => {
                this.bridgePromise = null;
                throw error;
            });
        }
        return this.bridgePromise;
    }

    private waitForBridge(): Promise<NonNullable<typeof window.nodejs>> {
        if (typeof window === 'undefined') {
            return Promise.reject(new Error('Node.js mobile runtime is not available'));
        }

        return new Promise((resolve, reject) => {
            let resolved = false;

            const cleanup = () => {
                resolved = true;
                if (typeof document !== 'undefined') {
                    document.removeEventListener('deviceready', readyHandler);
                }
            };

            const attempt = () => {
                if (resolved) {
                    return;
                }
                const bridge = this.acquireBridge();
                if (bridge) {
                    this.debug('bridge acquired via polling');
                    cleanup();
                    resolve(bridge);
                    return;
                }
                if (Date.now() - startTime >= BRIDGE_TIMEOUT_MS) {
                    cleanup();
                    reject(new Error('Node.js mobile runtime failed to initialize'));
                    return;
                }
                setTimeout(attempt, BRIDGE_POLL_INTERVAL_MS);
            };

            const readyHandler = () => {
                attempt();
            };

            const startTime = Date.now();
            if (typeof document !== 'undefined') {
                document.addEventListener('deviceready', readyHandler, { once: true });
            }
            attempt();
        });
    }

    private acquireBridge(): NonNullable<typeof window.nodejs> | null {
        if (window.nodejs) {
            this.debug('window.nodejs already set');
            return window.nodejs;
        }
        const cordovaRequire = window.cordova?.require;
        if (typeof cordovaRequire === 'function') {
            try {
                const plugin = cordovaRequire('nodejs-mobile-cordova.nodejs') as NonNullable<typeof window.nodejs> | undefined;
                if (plugin) {
                    window.nodejs = plugin;
                    this.debug('cordova.require resolved nodejs plugin');
                    return plugin;
                }
            } catch {
                // The module is not ready yet; keep polling.
                this.debug('cordova.require failed, will retry');
            }
        }
        return null;
    }

    private normalizeIncoming(raw: unknown): NodeMessage | null {
        if (!raw) {
            return null;
        }
        if (this.isNodeMessage(raw)) {
            return raw;
        }
        if (Array.isArray(raw)) {
            for (const entry of raw) {
                const normalized = this.normalizeIncoming(entry);
                if (normalized) {
                    return normalized;
                }
            }
            return null;
        }
        if (typeof raw === 'string') {
            try {
                const parsed = JSON.parse(raw);
                if (this.isNodeMessage(parsed)) {
                    return parsed;
                }
                return this.normalizeIncoming(parsed);
            } catch (error) {
                console.warn('Failed to parse message from Node runtime', error);
                return null;
            }
        }
        if (typeof raw === 'object') {
            const candidate = raw as { event?: unknown; payload?: unknown };
            if (candidate.event === 'message' && Array.isArray(candidate.payload)) {
                return this.normalizeIncoming(candidate.payload);
            }
        }
        return null;
    }

    private isNodeMessage(value: unknown): value is NodeMessage {
        return (
            !!value &&
            typeof value === 'object' &&
            typeof (value as NodeMessage).type === 'string'
        );
    }

    private debug(label: string, value?: unknown): void {
        if (!this.isDebugEnabled()) {
            return;
        }
        if (typeof value === 'undefined') {
            console.debug('[NodeController]', label);
        } else {
            console.debug('[NodeController]', label, value);
        }
    }

    private isDebugEnabled(): boolean {
        return typeof window !== 'undefined' && Boolean(window.__NONAME_DEBUG__);
    }
}

declare global {
    interface Window {
        __NONAME_DEBUG__?: boolean;
        __nonameNodeController?: NodeController;
    }
}

export const nodeController = new NodeController();
export type { NodeMessage };
