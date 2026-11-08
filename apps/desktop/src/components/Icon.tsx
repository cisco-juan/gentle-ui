import type { JSX } from "solid-js";

/**
 * Icon set.
 *
 * Hand-rolled 14px stroke icons instead of an icon package: the whole set is smaller than the
 * package metadata, and it keeps the visual rhythm consistent with the rest of the shell.
 */
export type IconName =
	| "panel"
	| "panel-right"
	| "plus"
	| "search"
	| "keyboard"
	| "folder"
	| "folder-plus"
	| "settings"
	| "chevron"
	| "sort"
	| "sun"
	| "terminal"
	| "check"
	| "warn"
	| "caret";

const PATHS: Record<IconName, JSX.Element> = {
	panel: (
		<>
			<rect x="2.5" y="3" width="11" height="10" rx="2" />
			<path d="M6.5 3v10" />
		</>
	),
	"panel-right": (
		<>
			<rect x="2.5" y="3" width="11" height="10" rx="2" />
			<path d="M9.5 3v10" />
		</>
	),
	plus: (
		<>
			<path d="M8 3.5v9M3.5 8h9" />
		</>
	),
	search: (
		<>
			<circle cx="7" cy="7" r="4" />
			<path d="M10 10l3.5 3.5" />
		</>
	),
	keyboard: (
		<>
			<rect x="1.5" y="4" width="13" height="8" rx="1.6" />
			<path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M4 9.5h8" />
		</>
	),
	folder: <path d="M1.8 4.2h4l1.2 1.6h7.2v6.4a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8V4.2z" />,
	"folder-plus": (
		<>
			<path d="M1.8 4.2h4l1.2 1.6h7.2v6.4a.8.8 0 0 1-.8.8H2.6a.8.8 0 0 1-.8-.8V4.2z" />
			<path d="M8 7.6v3.2M6.4 9.2h3.2" />
		</>
	),
	settings: (
		<>
			<circle cx="8" cy="8" r="2.1" />
			<path d="M8 1.8v1.4M8 12.8v1.4M2.2 8h1.4M12.4 8h1.4M3.9 3.9l1 1M11.1 11.1l1 1M12.1 3.9l-1 1M4.9 11.1l-1 1" />
		</>
	),
	chevron: <path d="M6 4l4 4-4 4" />,
	sort: (
		<>
			<path d="M4 3v10M4 13l-1.8-1.8M4 13l1.8-1.8" />
			<path d="M11 13V3M11 3L9.2 4.8M11 3l1.8 1.8" />
		</>
	),
	sun: (
		<>
			<circle cx="8" cy="8" r="2.6" />
			<path d="M8 1.5v1.2M8 13.3v1.2M2.4 8h1.2M12.4 8h1.2M4.1 4.1l.9.9M11 11l.9.9M11.9 4.1l-.9.9M5 11l-.9.9" />
		</>
	),
	terminal: (
		<>
			<rect x="1.8" y="3" width="12.4" height="10" rx="2" />
			<path d="M4.6 6.6l1.8 1.6-1.8 1.6M8.6 10h2.8" />
		</>
	),
	check: <path d="M3.2 8.4l3.1 3.1 6.5-6.9" />,
	warn: (
		<>
			<path d="M8 2.4l6 10.4H2L8 2.4z" />
			<path d="M8 6.4v3M8 11.2h.01" />
		</>
	),
	caret: <path d="M4 6l4 4 4-4" />,
};

export function Icon(props: { name: IconName; size?: number; class?: string }): JSX.Element {
	return (
		<svg
			class={props.class ?? "icon"}
			width={props.size ?? 14}
			height={props.size ?? 14}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			stroke-width="1.4"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{PATHS[props.name]}
		</svg>
	);
}
