import type { CardGenerator, SurfaceContext, SurfaceDrawProps, SurfaceInstance } from '@companion-surface/base'
import { getLink, type ErrorListener, type FrameListener, type Link, type PortInfo } from './link.js'
import {
	colourTo565,
	COLS,
	controlFor,
	keyFor,
	rgbToRgb565,
	ROWS,
	SIZE,
	T_BRIGHTNESS,
	T_COLOUR,
	T_HELLO,
	T_IMAGE,
	T_INFO,
	T_KEY,
	T_RELEASE,
} from './protocol.js'

type Frame = [type: number, payload: Buffer | undefined]

export class CommsSurface implements SurfaceInstance {
	readonly #surfaceId: string
	readonly #info: PortInfo
	readonly #context: SurfaceContext
	#link: Link | null = null
	#timer: NodeJS.Timeout | null = null
	/** key → last thing drawn on it (for resend) */
	readonly #latest = new Map<number, Frame>()
	/** key → waiting to go out (newest wins) */
	readonly #pending = new Map<number, Frame>()
	/** non-key frames (brightness etc), sent in order */
	readonly #control: Frame[] = []
	#helloDue = false
	#pumping = false
	#onFrame: FrameListener = () => {}
	#onErr: ErrorListener = () => {}

	constructor(surfaceId: string, info: PortInfo, context: SurfaceContext) {
		this.#surfaceId = surfaceId
		this.#info = info
		this.#context = context
	}

	get surfaceId(): string {
		return this.#surfaceId
	}
	get productName(): string {
		return 'Comms Remote V2'
	}

	async init(): Promise<void> {
		const link = getLink(this.#info.path)
		this.#link = link
		this.#onFrame = (type, p) => {
			if (type === T_KEY && p.length >= 2) {
				const id = controlFor(p[0])
				if (p[1]) this.#context.keyDownById(id)
				else this.#context.keyUpById(id)
			} else if (type === T_INFO && /fresh=1/.test(p.toString('ascii'))) {
				// box had dropped to placeholders - give it everything again
				for (const [k, f] of this.#latest) if (!this.#pending.has(k)) this.#pending.set(k, f)
				void this.#pump()
			}
		}
		this.#onErr = (err) => this.#context.disconnect(new Error(`Comms Remote unplugged (${err.message})`))
		link.listeners.add(this.#onFrame)
		link.errorListeners.add(this.#onErr)
		this.#hello()
		this.#timer = setInterval(() => this.#hello(), 2000) // keepalive, always jumps the queue
	}

	#hello(): void {
		this.#helloDue = true
		void this.#pump()
	}

	#queueKey(key: number, frame: Frame): void {
		this.#latest.set(key, frame)
		this.#pending.set(key, frame)
		void this.#pump()
	}

	// single sender: hello first, then control frames, then the newest frame for each key
	async #pump(): Promise<void> {
		if (this.#pumping) return
		this.#pumping = true
		try {
			while (this.#link && !this.#link.closed) {
				let frame: Frame | undefined
				if (this.#helloDue) {
					this.#helloDue = false
					frame = [T_HELLO, undefined]
				} else if (this.#control.length) frame = this.#control.shift()
				else if (this.#pending.size) {
					const [k, f] = this.#pending.entries().next().value as [number, Frame]
					this.#pending.delete(k)
					frame = f
				}
				if (!frame) break
				await this.#link.send(frame[0], frame[1])
			}
		} finally {
			this.#pumping = false
		}
	}

	async close(): Promise<void> {
		if (this.#timer) clearInterval(this.#timer)
		this.#timer = null
		this.#pending.clear()
		const link = this.#link
		this.#link = null
		if (link) {
			link.listeners.delete(this.#onFrame)
			link.errorListeners.delete(this.#onErr)
			await link.send(T_RELEASE).catch(() => null) // box back to placeholders; port stays open
		}
	}

	async updateConfig(): Promise<void> {}
	async ready(): Promise<void> {}

	async setBrightness(percent: number): Promise<void> {
		this.#control.push([T_BRIGHTNESS, Buffer.from([Math.max(0, Math.min(100, Math.round(percent)))])])
		void this.#pump()
	}

	async blank(): Promise<void> {
		for (let k = 0; k < COLS * ROWS; k++) this.#queueKey(k, [T_COLOUR, Buffer.from([k, 0, 0])])
	}

	async draw(signal: AbortSignal, props: SurfaceDrawProps): Promise<void> {
		if (!this.#link || signal?.aborted) return
		const key = keyFor(props.controlId)
		if (!(key >= 0 && key < COLS * ROWS)) return
		const image = (props as { image?: Uint8Array }).image
		if (image && image.length >= SIZE * SIZE * 3) {
			const px = rgbToRgb565(image, SIZE, SIZE)
			this.#queueKey(key, [T_IMAGE, Buffer.concat([Buffer.from([key, SIZE, SIZE]), px])])
		} else if (props.color) {
			const v = colourTo565(props.color)
			this.#queueKey(key, [T_COLOUR, Buffer.from([key, v & 0xff, v >> 8])])
		}
	}

	async showStatus(_signal: AbortSignal, _cards: CardGenerator, _message: string): Promise<void> {
		await this.blank()
	}
}
