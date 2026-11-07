// The box's USB framing and helpers. Matches surface.h in the box firmware.
//
// Frame: C0 DE | type | length (2 bytes, little-endian) | payload | CRC-16 (2 bytes, little-endian, plugin → box only)
// The CRC covers type, length and payload.

export const COLS = 3
export const ROWS = 2
export const SIZE = 76
export const F0 = 0xc0
export const F1 = 0xde

/** Plugin → box */
export const T_HELLO = 0x01
export const T_IMAGE = 0x02
export const T_COLOUR = 0x03
export const T_BRIGHTNESS = 0x04
export const T_RELEASE = 0x05 // CLEAR: back to numbered placeholders
/** Box → plugin */
export const T_INFO = 0x81
export const T_KEY = 0x82
export const T_ACK = 0x83

/** CRC-16/CCITT-FALSE, matches the firmware */
export function crc16(buf: Uint8Array): number {
	let c = 0xffff
	for (const b of buf) {
		c ^= b << 8
		for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff
	}
	return c
}

export function encodeFrame(type: number, payload: Buffer = Buffer.alloc(0)): Buffer {
	const body = Buffer.concat([Buffer.from([type, payload.length & 0xff, payload.length >> 8]), payload])
	const c = crc16(body)
	return Buffer.concat([Buffer.from([F0, F1]), body, Buffer.from([c & 0xff, c >> 8])])
}

/** Byte-at-a-time frame reader for what the box sends back (no CRC on these) */
export class FrameReader {
	#state = 0
	#type = 0
	#len = 0
	#payload: Buffer = Buffer.alloc(0)
	#pos = 0

	constructor(private readonly onFrame: (type: number, payload: Buffer) => void) {}

	feed(x: number): void {
		switch (this.#state) {
			case 0:
				if (x === F0) this.#state = 1
				break
			case 1:
				this.#state = x === F1 ? 2 : x === F0 ? 1 : 0
				break
			case 2:
				this.#type = x
				this.#state = 3
				break
			case 3:
				this.#len = x
				this.#state = 4
				break
			case 4:
				this.#len |= x << 8
				this.#payload = Buffer.alloc(this.#len)
				this.#pos = 0
				if (this.#len === 0) {
					this.#state = 0
					this.onFrame(this.#type, this.#payload)
				} else this.#state = 5
				break
			case 5:
				this.#payload[this.#pos++] = x
				if (this.#pos >= this.#len) {
					this.#state = 0
					this.onFrame(this.#type, this.#payload)
				}
				break
		}
	}
}

/** "comms-remote-v2;serial=AA:BB;fresh=1" → { product: 'comms-remote-v2', serial: 'AA:BB', fresh: '1' } */
export function parseInfo(s: string): Record<string, string> {
	const o: Record<string, string> = {}
	for (const part of String(s).split(';')) {
		const [k, v] = part.split('=')
		if (v === undefined) o.product = k
		else o[k] = v
	}
	return o
}

export const keyFor = (controlId: string): number => {
	const [r, c] = controlId.split('/').map(Number)
	return r * COLS + c
}
export const controlFor = (key: number): string => `${Math.floor(key / COLS)}/${key % COLS}`

export function rgbToRgb565(img: Uint8Array, w: number, h: number): Buffer {
	const out = Buffer.alloc(w * h * 2)
	for (let i = 0, o = 0; i < w * h; i++, o += 2) {
		const r = img[i * 3],
			g = img[i * 3 + 1],
			b = img[i * 3 + 2]
		const v = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)
		out[o] = v & 0xff
		out[o + 1] = v >> 8
	}
	return out
}

/** "#rrggbb" (or a number) → RGB565 */
export function colourTo565(colour: string | number): number {
	const n = typeof colour === 'number' ? colour : parseInt(String(colour).replace('#', ''), 16) || 0
	return (((n >> 16) & 0xf8) << 8) | (((n >> 8) & 0xfc) << 3) | ((n & 0xff) >> 3)
}
