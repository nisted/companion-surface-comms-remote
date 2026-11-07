// The USB serial link to the box, and finding boxes on the computer's ports.
// Windows: the COM port is driven via a PowerShell .NET SerialPort bridge; elsewhere it's opened as a file.
import fs from 'node:fs'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createModuleLogger } from '@companion-surface/base'
import { encodeFrame, FrameReader, T_ACK, T_HELLO, T_INFO } from './protocol.js'

const VID = '303A' // Espressif USB Serial/JTAG
const logger = createModuleLogger('comms-surface')

export interface PortInfo {
	path: string
	label: string
}

// ---------- port discovery ----------

function run(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout)))
	})
}

export async function listEspPorts(): Promise<PortInfo[]> {
	if (process.platform === 'win32') {
		const ps =
			"Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\\VID_" +
			VID +
			"*' -and $_.Name -match '\\((COM\\d+)\\)' } | ForEach-Object { $_.Name + '|' + $_.PNPDeviceID }"
		const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps])
		const found: PortInfo[] = []
		for (const line of out.split(/\r?\n/)) {
			const name = line.trim().split('|')[0]
			const com = name?.match(/\((COM\d+)\)/)?.[1]
			if (com) found.push({ path: '\\\\.\\' + com, label: com })
		}
		return found
	}
	// Linux / macOS
	const found: PortInfo[] = []
	const dir = '/dev/serial/by-id'
	try {
		for (const f of fs.readdirSync(dir)) if (/Espressif|303a/i.test(f)) found.push({ path: `${dir}/${f}`, label: f })
	} catch {
		/* no serial devices */
	}
	if (process.env.COMMS_SURFACE_PORT) found.push({ path: process.env.COMMS_SURFACE_PORT, label: 'test' })
	return found
}

// write every byte - Windows COM handles can accept a write only partially
function writeAll(fd: number, buf: Buffer): Promise<void> {
	return new Promise((resolve, reject) => {
		let off = 0
		const step = () => {
			fs.write(fd, buf, off, buf.length - off, null, (err, n) => {
				if (err) return reject(err)
				off += n
				if (off >= buf.length) resolve()
				else setImmediate(step)
			})
		}
		step()
	})
}

// ---------- Windows serial bridge ----------
// A plain file handle on a COM port makes every write wait behind the pending read,
// so on Windows the port is driven by a small PowerShell helper using .NET SerialPort
// (overlapped I/O: reading and writing run at the same time). Raw bytes over stdin/stdout.
function bridgeScript(com: string): string {
	return `
$ErrorActionPreference = 'Stop'
try {
  $p = New-Object System.IO.Ports.SerialPort '${com}', 115200
  $p.ReadTimeout = -1
  $p.WriteTimeout = 3000
  $p.Open()
  $bs = $p.BaseStream
  $in = [Console]::OpenStandardInput()
  $out = [Console]::OpenStandardOutput()
  [Console]::Error.WriteLine('READY')
  $null = $in.CopyToAsync($bs, 16384)
  $buf = New-Object byte[] 16384
  while ($true) {
    $n = $bs.Read($buf, 0, $buf.Length)
    if ($n -gt 0) { $out.Write($buf, 0, $n); $out.Flush() }
  }
} catch {
  [Console]::Error.WriteLine('ERR ' + $_.Exception.Message)
  exit 1
}
`
}

function spawnBridge(path: string): ChildProcessWithoutNullStreams {
	const com = path.match(/COM\d+/i)?.[0] ?? path
	const enc = Buffer.from(bridgeScript(com), 'utf16le').toString('base64')
	return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
		windowsHide: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	})
}

// ---------- serial link ----------

export type FrameListener = (type: number, payload: Buffer) => void
export type ErrorListener = (err: Error) => void

export class Link {
	readonly path: string
	closed = false
	readonly listeners = new Set<FrameListener>()
	readonly errorListeners = new Set<ErrorListener>()
	badFrames = 0

	readonly #useBridge = process.platform === 'win32'
	#child: ChildProcessWithoutNullStreams | null = null
	#fd = -1
	readonly #ready: Promise<void>
	#writeChain: Promise<void> = Promise.resolve()
	#ackWaiter: ((ok: boolean) => void) | null = null
	readonly #reader = new FrameReader((type, payload) => this.#emit(type, payload))

	constructor(path: string) {
		this.path = path
		if (this.#useBridge) {
			const child = spawnBridge(path)
			this.#child = child
			this.#ready = new Promise<void>((resolve, reject) => {
				let errText = ''
				child.stderr.on('data', (d: Buffer) => {
					const s = String(d)
					if (/READY/.test(s)) resolve()
					if (/ERR /.test(s)) {
						errText += s
						reject(new Error(s.trim()))
					}
				})
				child.on('exit', (code) => {
					const err = new Error(errText.trim() || `serial bridge exited (${code})`)
					reject(err)
					this.fail(err)
				})
				child.on('error', (err) => {
					reject(err)
					this.fail(err)
				})
			})
			this.#ready.catch(() => {})
			child.stdout.on('data', (d: Buffer) => {
				if (!this.closed) for (const x of d) this.#reader.feed(x)
			})
			child.stdin.on('error', (err) => this.fail(err))
		} else {
			this.#fd = fs.openSync(path, 'r+')
			this.#ready = Promise.resolve()
			this.#readLoop()
		}
	}

	#write(buf: Buffer): Promise<void> {
		if (!this.#useBridge) return writeAll(this.#fd, buf)
		return new Promise((resolve, reject) => {
			this.#child!.stdin.write(buf, (err) => (err ? reject(err) : resolve()))
		})
	}

	// one byte per read: Windows COM handles may block until the requested count arrives
	#readLoop(): void {
		const b = Buffer.alloc(1)
		const next = () => {
			if (this.closed) return
			fs.read(this.#fd, b, 0, 1, null, (err, n) => {
				if (this.closed) return
				if (err) return this.fail(err)
				if (n === 1) this.#reader.feed(b[0])
				setImmediate(next)
			})
		}
		next()
	}

	#emit(type: number, payload: Buffer): void {
		if (type === T_ACK && this.#ackWaiter) {
			const w = this.#ackWaiter
			this.#ackWaiter = null
			w(payload.length < 2 || payload[1] === 1)
		}
		for (const l of this.listeners) l(type, payload)
	}

	// box acks every frame once handled; resolves true (ok), false (bad checksum) or null (timeout)
	#waitAck(ms = 500): Promise<boolean | null> {
		return new Promise((resolve) => {
			const t = setTimeout(() => {
				this.#ackWaiter = null
				resolve(null)
			}, ms)
			this.#ackWaiter = (ok) => {
				clearTimeout(t)
				resolve(ok)
			}
		})
	}

	send(type: number, payload?: Buffer): Promise<void> {
		const buf = encodeFrame(type, payload)
		this.#writeChain = this.#writeChain.then(async () => {
			try {
				await this.#ready
			} catch {
				return
			}
			for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
				const acked = this.#waitAck()
				try {
					await this.#write(buf)
				} catch (err) {
					this.fail(err as Error)
					return
				}
				const ok = await acked
				if (ok) return
				if (ok === false) this.badFrames++
			}
		})
		return this.#writeChain
	}

	fail(err: Error): void {
		if (this.closed) return
		logger.warn(`link error ${err.message}`)
		this.close()
		links.delete(this.path)
		for (const l of this.errorListeners) l(err)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		if (this.#child) {
			try {
				this.#child.stdin.end()
			} catch {
				/* gone */
			}
			try {
				this.#child.kill()
			} catch {
				/* gone */
			}
		} else {
			try {
				fs.closeSync(this.#fd)
			} catch {
				/* gone */
			}
		}
	}
}

// One link per port, opened once and kept open: closing a Windows COM handle
// while a read is pending can strand a thread, so we never do that casually.
const links = new Map<string, Link>()
export function getLink(path: string): Link {
	let l = links.get(path)
	if (!l || l.closed) {
		l = new Link(path)
		links.set(path, l)
	}
	return l
}

/** Probe a port: send HELLO, wait for INFO. Allows for the bridge starting up. */
export function probe(path: string, timeoutMs = 6000): Promise<string | null> {
	return new Promise((resolve) => {
		let link: Link
		try {
			link = getLink(path)
		} catch {
			resolve(null)
			return
		}
		const onFrame: FrameListener = (type, p) => {
			if (type === T_INFO) done(p.toString('ascii'))
		}
		const onErr: ErrorListener = () => done(null)
		const done = (info: string | null) => {
			clearTimeout(t)
			link.listeners.delete(onFrame)
			link.errorListeners.delete(onErr)
			resolve(info)
		}
		const t = setTimeout(() => done(null), timeoutMs)
		link.listeners.add(onFrame)
		link.errorListeners.add(onErr)
		void link.send(T_HELLO)
	})
}
