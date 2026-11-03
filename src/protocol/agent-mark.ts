import { createHash } from "node:crypto";

// Deterministic agent marks: a mirrored 8x8 creature derived from an identity
// string (normally a public key). Same input, same mark; the mark is only a
// visual fingerprint and carries no authority on its own.

export const AGENT_MARK_PALETTE = ["#f2c14e", "#e8a33d", "#d97f3a", "#b5622f", "#8f4a2c", "#c96a52", "#e8b98a", "#f0d9a8"] as const;

const GRID = 8;
const HALF = GRID / 2;
const HALF_CELLS = GRID * HALF;
const FILL_THRESHOLD = 174; // ~68% of half-cells filled
const OPACITY_LEVELS = [0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;

export interface AgentMarkCell {
	row: number;
	col: number;
	opacity: number;
}

export interface AgentMark {
	color: string;
	/** Overall intensity, used when marks are shown as a field. */
	intensity: number;
	cells: AgentMarkCell[];
}

export const deriveAgentMark = (identity: string): AgentMark => {
	const bytes = createHash("shake256", { outputLength: 2 + HALF_CELLS * 2 })
		.update(`onlybots-agent-mark:v1:${identity}`)
		.digest();
	const color = AGENT_MARK_PALETTE[bytes[0] % AGENT_MARK_PALETTE.length];
	const intensity = Math.round((0.55 + (bytes[1] / 255) * 0.45) * 100) / 100;
	const cells: AgentMarkCell[] = [];
	for (let i = 0; i < HALF_CELLS; i++) {
		if (bytes[2 + i] >= FILL_THRESHOLD) {
			continue;
		}
		const row = Math.floor(i / HALF);
		const col = i % HALF;
		const opacity = OPACITY_LEVELS[Math.floor((bytes[2 + HALF_CELLS + i] / 256) * OPACITY_LEVELS.length)];
		cells.push({ row, col, opacity }, { row, col: GRID - 1 - col, opacity });
	}
	return { color, intensity, cells };
};

export interface AgentMarkGeometry {
	cell: number;
	pitch: number;
	radius: number;
}

/**
 * Renders a mark as SVG children (no outer <svg>). Cells sharing an opacity are
 * merged into one path; rounded corners come from a round-joined stroke so each
 * cell is a short path instead of a full <rect>.
 */
export const renderAgentMarkShapes = (mark: AgentMark, geometry: AgentMarkGeometry): string => {
	const { cell, pitch, radius } = geometry;
	const inner = cell - radius * 2;
	const byOpacity = new Map<number, string[]>();
	for (const c of mark.cells) {
		const x = c.col * pitch + radius;
		const y = c.row * pitch + radius;
		const segments = byOpacity.get(c.opacity) ?? [];
		segments.push(`M${x} ${y}h${inner}v${inner}h-${inner}z`);
		byOpacity.set(c.opacity, segments);
	}
	const paths = [...byOpacity.entries()]
		.sort(([a], [b]) => a - b)
		.map(([opacity, segments]) => `<path${opacity < 1 ? ` opacity="${opacity}"` : ""} d="${segments.join("")}"/>`)
		.join("");
	return `<g fill="${mark.color}" stroke="${mark.color}" stroke-width="${radius * 2}" stroke-linejoin="round">${paths}</g>`;
};

export const agentMarkSize = (geometry: AgentMarkGeometry): number => (GRID - 1) * geometry.pitch + geometry.cell;

export const renderAgentMarkSvg = (identity: string, attributes = 'aria-hidden="true"'): string => {
	const geometry = { cell: 9, pitch: 10, radius: 1 };
	const size = agentMarkSize(geometry);
	return `<svg viewBox="0 0 ${size} ${size}" ${attributes}>${renderAgentMarkShapes(deriveAgentMark(identity), geometry)}</svg>`;
};

/** Plain text uses the same cell geometry without terminal color or escape codes. */
export const renderAgentMarkText = (identity: string): string => {
 const cells = new Set(deriveAgentMark(identity).cells.map(cell => `${cell.row}:${cell.col}`));
 return Array.from({ length: GRID }, (_, row) => Array.from({ length: GRID }, (_, col) => cells.has(`${row}:${col}`) ? "██" : "  ").join("").trimEnd()).join("\n");
};
