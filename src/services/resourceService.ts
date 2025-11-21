import { Preferences } from '@capacitor/preferences';
import { nodeController, type NodeMessage } from './nodeController';

const RESOURCE_URL_KEY = 'noname-resource-url';
const RESOURCE_BRANCH_KEY = 'noname-resource-branch';
const DEFAULT_URL = 'https://github.com/libnoname/noname.git';
const DEFAULT_BRANCH = 'main';

export type ResourceState = {
    resourceUrl: string;
    branch: string;
    version: string | null;
    hasResources: boolean;
    serverRunning: boolean;
    webServerPort: number | null;
};

export type DownloadProgress = {
    downloaded: number;
    total: number;
};

class ResourceService {
    private state: ResourceState = {
        resourceUrl: DEFAULT_URL,
        branch: DEFAULT_BRANCH,
        version: null,
        hasResources: false,
        serverRunning: false,
        webServerPort: null,
    };
    private progress: DownloadProgress | null = null;
    private listeners = new Set<(state: ResourceState) => void>();
    private progressListeners = new Set<(progress: DownloadProgress | null) => void>();
    private errorListeners = new Set<(error: string) => void>();

    constructor() {
        nodeController.on((message) => {
            this.handleNodeMessage(message);
        });
    }

    async init(): Promise<void> {
        await nodeController.ensureStarted();
        const [storedUrl, storedBranch] = await Promise.all([
            Preferences.get({ key: RESOURCE_URL_KEY }),
            Preferences.get({ key: RESOURCE_BRANCH_KEY }),
        ]);
        if (storedUrl.value) {
            this.state.resourceUrl = storedUrl.value;
            this.safeSend({
                type: 'set-resource-url',
                payload: { url: storedUrl.value },
            });
        }
        if (storedBranch.value) {
            this.state.branch = storedBranch.value;
            this.safeSend({
                type: 'set-resource-url',
                payload: { url: this.state.resourceUrl, branch: storedBranch.value },
            });
        }
        this.safeSend({ type: 'get-state' });
    }

    getState(): ResourceState {
        return this.state;
    }

    getProgress(): DownloadProgress | null {
        return this.progress;
    }

    onState(listener: (state: ResourceState) => void): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    onProgress(listener: (progress: DownloadProgress | null) => void): () => void {
        this.progressListeners.add(listener);
        listener(this.progress);
        return () => {
            this.progressListeners.delete(listener);
        };
    }

    onError(listener: (error: string) => void): () => void {
        this.errorListeners.add(listener);
        return () => {
            this.errorListeners.delete(listener);
        };
    }

    async setResourceUrl(url: string, branch: string): Promise<void> {
        this.state.resourceUrl = url;
        this.state.branch = branch;
        await Preferences.set({ key: RESOURCE_URL_KEY, value: url });
        await Preferences.set({ key: RESOURCE_BRANCH_KEY, value: branch });
        this.safeSend({ type: 'set-resource-url', payload: { url, branch } });
        this.emitState();
    }

    downloadResources(): void {
        this.progress = null;
        this.emitProgress();
        this.safeSend({ type: 'download-resources' });
    }

    startServer(): void {
        this.safeSend({ type: 'start-server' });
    }

    stopServer(): void {
        this.safeSend({ type: 'stop-server' });
    }

    startWeb(): void {
        this.safeSend({ type: 'start-web' });
    }

    stopWeb(): void {
        this.safeSend({ type: 'stop-web' });
    }

    private handleNodeMessage(message: NodeMessage): void {
        switch (message.type) {
            case 'ready':
            case 'state':
                this.updateState(message.payload);
                break;
            case 'download-progress':
                this.updateProgress(message.payload);
                break;
            case 'download-started':
                this.progress = { downloaded: 0, total: 0 };
                this.emitProgress();
                break;
            case 'download-complete':
                this.updateState(message.payload);
                this.progress = null;
                this.emitProgress();
                break;
            case 'server-started':
                this.state.serverRunning = true;
                this.emitState();
                break;
            case 'server-stopped':
                this.state.serverRunning = false;
                this.emitState();
                break;
            case 'web-started':
                if (typeof message.payload?.port === 'number') {
                    this.state.webServerPort = message.payload.port;
                    this.emitState();
                }
                break;
            case 'web-stopped':
                this.state.webServerPort = null;
                this.emitState();
                break;
            case 'error':
                if (message.payload && typeof message.payload === 'object') {
                    const info = message.payload as Record<string, unknown>;
                    if (typeof info.message === 'string') {
                        this.emitError(info.message);
                    }
                }
                break;
            default:
                break;
        }
    }

    private updateState(payload: unknown): void {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        const data = payload as Record<string, unknown>;
        const nextState: ResourceState = {
            resourceUrl: typeof data.resourceUrl === 'string' ? data.resourceUrl : this.state.resourceUrl,
            branch: typeof data.branch === 'string' ? data.branch : this.state.branch,
            version: typeof data.version === 'string' ? data.version : this.state.version,
            hasResources: typeof data.hasResources === 'boolean' ? data.hasResources : this.state.hasResources,
            serverRunning: typeof data.serverRunning === 'boolean' ? data.serverRunning : this.state.serverRunning,
            webServerPort: typeof data.webServerPort === 'number' ? data.webServerPort : this.state.webServerPort,
        };
        this.state = nextState;
        this.emitState();
    }

    private updateProgress(payload: unknown): void {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        const data = payload as Record<string, unknown>;
        const downloaded = typeof data.downloaded === 'number' ? data.downloaded : 0;
        const total = typeof data.total === 'number' ? data.total : 0;
        this.progress = { downloaded, total };
        this.emitProgress();
    }

    private emitState(): void {
        this.listeners.forEach((listener) => listener(this.state));
    }

    private emitProgress(): void {
        this.progressListeners.forEach((listener) => listener(this.progress));
    }

    private emitError(message: string): void {
        this.errorListeners.forEach((listener) => listener(message));
    }

    private safeSend(message: NodeMessage): void {
        nodeController.send(message).catch((err) => {
            this.emitError(err instanceof Error ? err.message : String(err));
        });
    }
}

export const resourceService = new ResourceService();
