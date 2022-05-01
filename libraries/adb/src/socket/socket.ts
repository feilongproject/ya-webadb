import { PromiseResolver } from "@yume-chan/async";
import type { Disposable } from "@yume-chan/event";
import { AdbCommand } from '../packet.js';
import { ChunkStream, DuplexStreamFactory, pipeFrom, PushReadableStream, WritableStream, type PushReadableStreamController, type ReadableStream, type ReadableWritablePair } from '../stream/index.js';
import type { AdbPacketDispatcher, Closeable } from './dispatcher.js';

export interface AdbSocketInfo {
    localId: number;
    remoteId: number;

    localCreated: boolean;
    serviceString: string;
}

export interface AdbSocketConstructionOptions extends AdbSocketInfo {
    dispatcher: AdbPacketDispatcher;

    highWaterMark?: number | undefined;
}

export class AdbSocketController implements AdbSocketInfo, ReadableWritablePair<Uint8Array, Uint8Array>, Closeable, Disposable {
    private readonly dispatcher!: AdbPacketDispatcher;

    public readonly localId!: number;
    public readonly remoteId!: number;
    public readonly localCreated!: boolean;
    public readonly serviceString!: string;

    private _factory: DuplexStreamFactory<Uint8Array, Uint8Array>;

    private _readable: ReadableStream<Uint8Array>;
    private _readableController!: PushReadableStreamController<Uint8Array>;
    public get readable() { return this._readable; }

    private _writePromise: PromiseResolver<void> | undefined;
    public readonly writable: WritableStream<Uint8Array>;

    private _closed = false;
    public get closed() { return this._closed; }

    private _socket: AdbSocket;
    public get socket() { return this._socket; }

    public constructor(options: AdbSocketConstructionOptions) {
        Object.assign(this, options);

        // Check this image to help you understand the stream graph
        // cspell: disable-next-line
        // https://www.plantuml.com/plantuml/png/TL0zoeGm4ErpYc3l5JxyS0yWM6mX5j4C6p4cxcJ25ejttuGX88ZftizxUKmJI275pGhXl0PP_UkfK_CAz5Z2hcWsW9Ny2fdU4C1f5aSchFVxA8vJjlTPRhqZzDQMRB7AklwJ0xXtX0ZSKH1h24ghoKAdGY23FhxC4nS2pDvxzIvxb-8THU0XlEQJ-ZB7SnXTAvc_LhOckhMdLBnbtndpb-SB7a8q2SRD_W00

        this._factory = new DuplexStreamFactory<Uint8Array, Uint8Array>({
            close: async () => {
                await this.dispatcher.sendPacket(
                    AdbCommand.Close,
                    this.localId,
                    this.remoteId
                );

                // Don't `dispose` here, we need to wait for `CLSE` response packet.
                return false;
            },
            dispose: () => {
                this._closed = true;

                // Error out the pending writes
                this._writePromise?.reject(new Error('Socket closed'));
            },
        });

        this._readable = this._factory.wrapReadable(
            new PushReadableStream(controller => {
                this._readableController = controller;
            }, {
                highWaterMark: options.highWaterMark ?? 16 * 1024,
                size(chunk) { return chunk.byteLength; }
            })
        );

        this.writable = pipeFrom(
            this._factory.createWritable(
                new WritableStream({
                    write: async (chunk) => {
                        // Wait for an ack packet
                        this._writePromise = new PromiseResolver();
                        await this.dispatcher.sendPacket(
                            AdbCommand.Write,
                            this.localId,
                            this.remoteId,
                            chunk
                        );
                        await this._writePromise.promise;
                    }
                }),
            ),
            new ChunkStream(this.dispatcher.options.maxPayloadSize)
        );

        this._socket = new AdbSocket(this);
    }

    public async enqueue(packet: Uint8Array) {
        await this._readableController.enqueue(packet);
    }

    public ack() {
        this._writePromise?.resolve();
    }

    public async close(): Promise<void> {
        this._factory.close();
    }

    public dispose() {
        this._factory.dispose();
    }
}

/**
 * AdbSocket is a duplex stream.
 *
 * To close it, call either `socket.close()`,
 * `socket.readable.cancel()`, `socket.readable.getReader().cancel()`,
 * `socket.writable.abort()`, `socket.writable.getWriter().abort()`,
 * `socket.writable.close()` or `socket.writable.getWriter().close()`.
 */
export class AdbSocket implements AdbSocketInfo, ReadableWritablePair<Uint8Array, Uint8Array>{
    private _controller: AdbSocketController;

    public get localId(): number { return this._controller.localId; }
    public get remoteId(): number { return this._controller.remoteId; }
    public get localCreated(): boolean { return this._controller.localCreated; }
    public get serviceString(): string { return this._controller.serviceString; }

    public get readable(): ReadableStream<Uint8Array> { return this._controller.readable; }
    public get writable(): WritableStream<Uint8Array> { return this._controller.writable; }

    public constructor(controller: AdbSocketController) {
        this._controller = controller;
    }

    public close() {
        return this._controller.close();
    }
}
