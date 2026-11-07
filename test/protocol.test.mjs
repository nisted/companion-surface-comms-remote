// Checks the USB framing against the firmware's format, without a box. Run after 'yarn build': yarn test
import assert from 'node:assert/strict'
import { test } from 'node:test'

const dist = new URL('../dist/', import.meta.url).href
const p = await import(new URL('protocol.js', dist))

test('CRC-16/CCITT-FALSE check value', () => {
	assert.equal(p.crc16(Buffer.from('123456789', 'ascii')), 0x29b1)
})

test('frame layout: header, type, little-endian length, payload, CRC', () => {
	const f = p.encodeFrame(p.T_BRIGHTNESS, Buffer.from([50]))
	assert.deepEqual([...f.subarray(0, 6)], [0xc0, 0xde, 0x04, 1, 0, 50])
	const c = p.crc16(f.subarray(2, 6))
	assert.deepEqual([...f.subarray(6)], [c & 0xff, c >> 8])
	assert.equal(p.encodeFrame(p.T_HELLO).length, 7)
})

test('reader picks frames out of noise', () => {
	const got = []
	const r = new p.FrameReader((type, payload) => got.push([type, [...payload]]))
	for (const x of [0x00, 0xc0, 0xc0, 0xde, 0x82, 2, 0, 4, 1, 0xff, 0xc0, 0xde, 0x83, 0, 0]) r.feed(x)
	assert.deepEqual(got, [
		[0x82, [4, 1]],
		[0x83, []],
	])
})

test('key numbering: top row 0-2, bottom row 3-5', () => {
	assert.equal(p.keyFor('0/0'), 0)
	assert.equal(p.keyFor('1/2'), 5)
	assert.equal(p.controlFor(4), '1/1')
})

test('colours to RGB565', () => {
	assert.equal(p.colourTo565('#ff0000'), 0xf800)
	assert.equal(p.colourTo565('#00ff00'), 0x07e0)
	assert.equal(p.colourTo565(0x0000ff), 0x001f)
	assert.deepEqual([...p.rgbToRgb565(Uint8Array.from([255, 255, 255]), 1, 1)], [0xff, 0xff])
})

test('INFO string', () => {
	assert.deepEqual(p.parseInfo('comms-remote-v2;serial=AA:BB;fresh=1'), { product: 'comms-remote-v2', serial: 'AA:BB', fresh: '1' })
})
