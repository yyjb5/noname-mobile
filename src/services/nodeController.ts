type NodeMessage = {
    type: string;
    payload?: Record<string, unknown>;
};

type Listener = (message: NodeMessage) => void;

class NodeController {
    private started = false;
    private listeners = new Set<Listener>();

    async ensureStarted(): Promise<void> {
        if (this.started) {
            return;
        }
        const bridge = this.getBridge();
        bridge.channel.on('message', (raw) => {
            const message = (raw ?? {}) as NodeMessage;
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

    send(message: NodeMessage): void {
        const bridge = this.getBridge();
        bridge.channel.send(message);
    }

    on(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private getBridge(): NonNullable<typeof window.nodejs> {
        if (!window.nodejs) {
            throw new Error('Node.js mobile runtime is not available');
        }
        return window.nodejs;
    }
}

export const nodeController = new NodeController();
export type { NodeMessage };
