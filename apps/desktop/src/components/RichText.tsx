import { For, Match, Switch, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";

/**
 * Minimal markdown renderer.
 *
 * Deliberately not a library and deliberately not `innerHTML`: the output is model text, so every
 * node is built as JSX and nothing is ever parsed as HTML. It covers what agent answers actually
 * use — paragraphs, headings, lists, quotes, fenced code and the inline basics.
 */

type Block =
	| { kind: "paragraph"; text: string }
	| { kind: "heading"; level: number; text: string }
	| { kind: "list"; ordered: boolean; items: string[] }
	| { kind: "quote"; text: string }
	| { kind: "code"; language: string; code: string }
	| { kind: "rule" };

const FENCE = /^```\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const RULE = /^([-*_]\s*){3,}$/;

export function RichText(props: { text: string }): JSX.Element {
	return <div class="prose">{blocks(props.text).map(renderBlock)}</div>;
}

function blocks(source: string): Block[] {
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const out: Block[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";

		if (line.trim().length === 0) {
			index++;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			const language = fence[1] ?? "";
			const body: string[] = [];
			index++;
			while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
				body.push(lines[index] ?? "");
				index++;
			}
			index++;
			out.push({ kind: "code", language, code: body.join("\n") });
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			out.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
			index++;
			continue;
		}

		if (RULE.test(line.trim())) {
			out.push({ kind: "rule" });
			index++;
			continue;
		}

		if (BULLET.test(line) || ORDERED.test(line)) {
			const ordered = ORDERED.test(line);
			const pattern = ordered ? ORDERED : BULLET;
			const items: string[] = [];
			while (index < lines.length) {
				const match = pattern.exec(lines[index] ?? "");
				if (!match) break;
				items.push(match[1] ?? "");
				index++;
			}
			out.push({ kind: "list", ordered, items });
			continue;
		}

		if (line.startsWith(">")) {
			const quoted: string[] = [];
			while (index < lines.length && (lines[index] ?? "").startsWith(">")) {
				quoted.push((lines[index] ?? "").replace(/^>\s?/, ""));
				index++;
			}
			out.push({ kind: "quote", text: quoted.join("\n") });
			continue;
		}

		const paragraph: string[] = [];
		while (index < lines.length) {
			const current = lines[index] ?? "";
			if (current.trim().length === 0) break;
			if (FENCE.test(current) || HEADING.test(current) || BULLET.test(current) || ORDERED.test(current)) break;
			if (current.startsWith(">")) break;
			paragraph.push(current);
			index++;
		}
		out.push({ kind: "paragraph", text: paragraph.join("\n") });
	}

	return out;
}

// An element chosen at runtime is a `Dynamic`: a capitalised tag variable is a component call, so
// `const Tag = "ul"; <Tag>` throws "Comp is not a function" at render.
function renderBlock(block: Block): JSX.Element {
	return (
		<Switch>
			<Match when={block.kind === "paragraph" ? block : null}>
				{(value) => <p>{inline(value().text)}</p>}
			</Match>
			<Match when={block.kind === "heading" ? block : null}>
				{(value) => <Dynamic component={`h${Math.min(value().level + 1, 6)}`}>{inline(value().text)}</Dynamic>}
			</Match>
			<Match when={block.kind === "list" ? block : null}>
				{(value) => (
					<Dynamic component={value().ordered ? "ol" : "ul"}>
						<For each={value().items}>{(item) => <li>{inline(item)}</li>}</For>
					</Dynamic>
				)}
			</Match>
			<Match when={block.kind === "quote" ? block : null}>
				{(value) => <blockquote>{inline(value().text)}</blockquote>}
			</Match>
			<Match when={block.kind === "code" ? block : null}>
				{(value) => (
					<pre class="code" data-language={value().language || undefined}>
						<code>{value().code}</code>
					</pre>
				)}
			</Match>
			<Match when={block.kind === "rule"}>
				<hr />
			</Match>
		</Switch>
	) as JSX.Element;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\s]+\))|(https?:\/\/[^\s<)]+)/g;

/** Inline spans. Built as JSX nodes, so no text is ever interpreted as markup. */
function inline(text: string): JSX.Element[] {
	const out: JSX.Element[] = [];
	let cursor = 0;
	let key = 0;

	for (const match of text.matchAll(INLINE)) {
		const at = match.index ?? 0;
		if (at > cursor) out.push(<>{text.slice(cursor, at)}</>);
		const token = match[0];

		if (token.startsWith("`")) {
			out.push(<code class="inline">{token.slice(1, -1)}</code>);
		} else if (token.startsWith("**") || token.startsWith("__")) {
			out.push(<strong>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("~~")) {
			out.push(<del>{token.slice(2, -2)}</del>);
		} else if (token.startsWith("*") || token.startsWith("_")) {
			out.push(<em>{token.slice(1, -1)}</em>);
		} else if (token.startsWith("[")) {
			const split = token.indexOf("](");
			const label = token.slice(1, split);
			const href = token.slice(split + 2, -1);
			out.push(
				<a href={href} target="_blank" rel="noreferrer noopener">
					{label}
				</a>,
			);
		} else {
			out.push(
				<a href={token} target="_blank" rel="noreferrer noopener">
					{token}
				</a>,
			);
		}
		cursor = at + token.length;
		key++;
	}

	if (cursor < text.length) out.push(<>{text.slice(cursor)}</>);
	return out;
}
