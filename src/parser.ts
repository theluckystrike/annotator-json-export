export type Annotation = Record<string, unknown>;
export interface Row { annotation: Annotation; source: string; block: number; line: number }
export interface ParseError { source: string; block: number; line: number; message: string }
export interface Parsed { rows: Row[]; errors: ParseError[]; blocks: number }

function unquote(line: string): string {
	return line.replace(/^\s*> ?/, '');
}

function closesFence(line: string, fence: string): boolean {
	const match = /^(`{3,}|~{3,})\s*$/.exec(line.trim());
	return !!match && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

/** Reads the saved format. This parser does not use Annotator source code. */
export function parseAnnotations(markdown: string, source = ''): Parsed {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
	const result: Parsed = { rows: [], errors: [], blocks: 0 };
	let otherFence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = unquote(lines[i]!).trim();
		if (otherFence) {
			if (closesFence(line, otherFence)) otherFence = null;
			continue;
		}
		const direct = /^(`{3,}|~{3,})annotation-json\s*$/.exec(line);
		const fence = direct?.[1];
		if (!fence) {
			const other = /^(`{3,}|~{3,})/.exec(line);
			if (other) otherFence = other[1]!;
			continue;
		}
		result.blocks++;
		const quoted = /^\s*>/.test(lines[i]!);
		const blockLine = (raw: string): string => quoted ? unquote(raw) : raw;
		const block = result.blocks;
		const start = i + 1;
		const jsonLines: string[] = [];
		let closed = false;
		for (i++; i < lines.length; i++) {
			const content = blockLine(lines[i]!);
			if (closesFence(content, fence)) { closed = true; break; }
			if (/^(`{3,}|~{3,})annotation-json\s*$/.test(content.trim())) { i--; break; }
			jsonLines.push(content);
		}
		const fail = (message: string) => result.errors.push({ source, block, line: start, message });
		if (!closed) { fail('Missing closing JSON fence.'); continue; }
		let annotation: Annotation;
		try {
			let unsupportedNumber = false;
			const value: unknown = JSON.parse(jsonLines.join('\n'), (_key: string, field: unknown) => {
				if (typeof field === 'number' && (!Number.isFinite(field) || (Number.isInteger(field) && !Number.isSafeInteger(field)))) unsupportedNumber = true;
				return field;
			});
			if (unsupportedNumber) { fail('Numeric field is outside the supported range.'); continue; }
			if (value === null || Array.isArray(value) || typeof value !== 'object') { fail('Annotation must be a JSON object.'); continue; }
			annotation = { ...value as Annotation };
		} catch { fail('Invalid JSON.'); continue; }
		const tail: string[] = [];
		let tailFence: string | null = null;
		let marked = false;
		for (let j = i + 1; j < lines.length; j++) {
			const raw = lines[j]!;
			const content = blockLine(raw);
			const id = /^\s*\^([A-Za-z0-9-]+)\s*$/.exec(content);
			if (quoted && !/^\s*>/.test(raw) && content.trim() && !id) break;
			if (tailFence) {
				tail.push(content);
				if (closesFence(content, tailFence)) tailFence = null;
				continue;
			}
			if (/^(`{3,}|~{3,})annotation-json\s*$/.test(content.trim())) break;
			const code = /^(`{3,}|~{3,})/.exec(content.trim());
			if (code) {
				if (!marked) break;
				tailFence = code[1]!;
			} else if (/^\s*%%(?:COMMENT|TAGS)%%/.test(content)) marked = true;
			if (id) { annotation.id = id[1]!; break; }
			if (!marked && content.trim() && !/^\s*(?:\*?%%)/.test(content)) break;
			tail.push(content);
		}
		const section = (marker: string): string | null => {
			let content: string[] | null = null;
			let codeFence: string | null = null;
			for (const text of tail) {
				if (codeFence) {
					content?.push(text);
					if (closesFence(text, codeFence)) codeFence = null;
					continue;
				}
				const code = /^(`{3,}|~{3,})/.exec(text.trim());
				if (code) codeFence = code[1]!;
				if (!code && /^\s*%%[A-Z]+%%/.test(text)) {
					if (content !== null) break;
					if (text.trimStart().startsWith(marker)) content = [text.trimStart().slice(marker.length)];
				} else content?.push(text);
			}
			return content === null ? null : content.join('\n').trim();
		};
		const comment = section('%%COMMENT%%');
		const tags = section('%%TAGS%%');
		if (comment !== null) annotation.text = comment;
		if (tags !== null) annotation.tags = [...new Set([...tags.matchAll(/(?:^|[\s,])#([\p{L}\p{M}\p{N}_/-]+)/gu)].map((m) => m[1]!))];
		result.rows.push({ annotation, source, block, line: start });
	}
	return result;
}

export function archiveJson(rows: Row[]): string {
	return JSON.stringify({ rows: rows.map((r) => r.annotation), total: rows.length }, null, 2) + '\n';
}

export function uniquePath(base: string, extension: string, exists: (path: string) => boolean): string {
	let path = `${base}.${extension}`;
	for (let n = 2; exists(path); n++) path = `${base} (${n}).${extension}`;
	return path;
}

export function fileStamp(date: Date): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

export function errorReport(parsed: Parsed, exported: number): string {
	const safe = (source: string): string => {
		const text = source.replace(/[\r\n]/g, ' ');
		let length = 1;
		for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
		const fence = '`'.repeat(length);
		return `${fence} ${text} ${fence}`;
	};
	return `# Annotation export report\n\nExported rows: ${exported}\n\nParse errors: ${parsed.errors.length}\n\n` +
		(parsed.errors.map((e) => `- ${safe(e.source)} | block ${e.block} | line ${e.line} | ${e.message}`).join('\n') || 'No parse errors.') + '\n';
}
