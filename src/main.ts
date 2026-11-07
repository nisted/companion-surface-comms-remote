// Comms Remote V2: Companion surface plugin. The box's 3x2 touch grid over USB serial.
import type { DetectionSurfaceInfo, OpenSurfaceResult, SurfaceContext, SurfacePlugin } from '@companion-surface/base'
import { CommsSurface } from './instance.js'
import { listEspPorts, probe, type PortInfo } from './link.js'
import { COLS, parseInfo, ROWS, SIZE } from './protocol.js'

/** Ports that already have a surface open on them */
const openPaths = new Set<string>()

const CommsRemotePlugin: SurfacePlugin<PortInfo> = {
	init: async (): Promise<void> => {},
	destroy: async (): Promise<void> => {},

	scanForSurfaces: async (): Promise<DetectionSurfaceInfo<PortInfo>[]> => {
		const results: DetectionSurfaceInfo<PortInfo>[] = []
		for (const port of await listEspPorts()) {
			if (openPaths.has(port.path)) continue
			const raw = await probe(port.path)
			if (!raw) continue
			const info = parseInfo(raw)
			if (info.product !== 'comms-remote-v2') continue
			const serial = (info.serial || port.label).replace(/:/g, '')
			results.push({
				deviceHandle: `comms-remote:${port.path}`,
				surfaceId: `comms-remote:${serial}`,
				description: `Comms Remote V2 (${port.label})`,
				pluginInfo: { path: port.path, label: port.label },
			})
		}
		return results
	},

	openSurface: async (surfaceId: string, info: PortInfo, context: SurfaceContext): Promise<OpenSurfaceResult> => {
		const surface = new CommsSurface(surfaceId, info, context)
		openPaths.add(info.path)
		const origClose = surface.close.bind(surface)
		surface.close = async () => {
			openPaths.delete(info.path)
			await origClose()
		}
		const controls: Record<string, { row: number; column: number }> = {}
		for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) controls[`${r}/${c}`] = { row: r, column: c }
		return {
			surface,
			registerProps: {
				brightness: true,
				surfaceLayout: {
					stylePresets: { default: { bitmap: { w: SIZE, h: SIZE, format: 'rgb' } } },
					controls,
				},
				transferVariables: [],
				pincodeMap: null,
				location: info.label,
				configFields: [
					{
						id: 'crew',
						type: 'static-text',
						label: "Psst. This one's got mates. 🍹",
						value:
							"Comms Remote Surface is part of a little crew of Companion modules: some brand new, some old favourites given a good tweak. Want to know who else is in the crew, or grab the freshest version of each one? It's all here: " +
							'https://github.com/nisted/companion-modules',
					},
				],
			},
		}
	},
}

export default CommsRemotePlugin
