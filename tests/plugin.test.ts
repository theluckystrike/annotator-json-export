import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import AnnotatorJsonExportPlugin from '../src/main';
import { parseAnnotations, archiveJson, errorReport, fileStamp } from '../src/parser';
import * as pro from '../src/pro';
import manifest from '../manifest.json';

export function makePlugin(files: Record<string, string> = {}) {
	const app = App.createConfigured__({ files });
	return new AnnotatorJsonExportPlugin(app as never, manifest as never);
}
const note = '```annotation-json\n{"text":"Saved","target":[]}\n```\n^row';
afterEach(() => { vi.restoreAllMocks(); pro.resetPro(); });

describe('Local export and Pro guards', () => {
	it('creates a JSON archive and keeps source bytes', async () => {
		const plugin = makePlugin({ 'Source.md': note });
		const parsed = parseAnnotations(note, 'Source.md');
		expect(await plugin.saveExport(parsed, parsed.rows, false, false)).toEqual(['Export.json']);
		const file = plugin.app.vault.getFileByPath('Export.json')!;
		expect(JSON.parse(await plugin.app.vault.read(file))).toEqual({ rows: [{ text: 'Saved', target: [], id: 'row' }], total: 1 });
		expect(await plugin.app.vault.read(plugin.app.vault.getFileByPath('Source.md')!)).toBe(note);
	});
	it('free state refuses folder and dated writes', async () => {
		const plugin = makePlugin(); const parsed = parseAnnotations(note);
		expect(await plugin.saveExport(parsed, parsed.rows, true, false)).toEqual([]);
		expect(await plugin.saveExport(parsed, parsed.rows, false, true)).toEqual([]);
		expect(plugin.app.vault.getFiles()).toHaveLength(0);
	});
	it('Pro creates dated JSON and a Markdown error report', async () => {
		vi.spyOn(pro, 'isPro').mockReturnValue(true);
		vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T08:30:00Z'));
		try {
			const plugin = makePlugin(); const parsed = parseAnnotations(note + '\n```annotation-json\n{bad}\n```', 'Source.md');
			const paths = await plugin.saveExport(parsed, parsed.rows, true, true);
			expect(paths).toEqual(['Export 2026-10-14T08-30-00-000Z.json', 'Export 2026-10-14T08-30-00-000Z errors.md']);
			const report = await plugin.app.vault.read(plugin.app.vault.getFileByPath(paths[1]!)!);
			expect(report).toContain('` Source.md ` | block 2 | line 5 | Invalid JSON.');
		} finally { vi.useRealTimers(); }
	});
	it('rejects an empty export and rows outside the preview', async () => {
		const plugin = makePlugin(); const parsed = parseAnnotations(note);
		await expect(plugin.saveExport(parsed, [], false, false)).rejects.toThrow('Select valid');
		await expect(plugin.saveExport(parsed, parseAnnotations(note).rows, false, false)).rejects.toThrow('Select valid');
	});
	it('exports only the selected valid row', async () => {
		const plugin = makePlugin(); const parsed = parseAnnotations(note + '\n' + note.replace('row','other'));
		await plugin.saveExport(parsed, [parsed.rows[1]!], false, false);
		expect(JSON.parse(await plugin.app.vault.read(plugin.app.vault.getFileByPath('Export.json')!)).total).toBe(1);
	});
	it('does not fall back to source mutation on write failure', async () => {
		const plugin = makePlugin({ 'Source.md': note }); const parsed = parseAnnotations(note);
		vi.spyOn(plugin.app.vault, 'create').mockRejectedValue(new Error('Read only'));
		await expect(plugin.saveExport(parsed, parsed.rows, false, false)).rejects.toThrow('Read only');
		expect(await plugin.app.vault.read(plugin.app.vault.getFileByPath('Source.md')!)).toBe(note);
	});
	it('keeps a successful JSON file if the report write fails', async () => {
		vi.spyOn(pro, 'isPro').mockReturnValue(true);
		const plugin = makePlugin(); const parsed = parseAnnotations(note);
		const create = plugin.app.vault.create.bind(plugin.app.vault);
		vi.spyOn(plugin.app.vault, 'create').mockImplementation((path, data) => path.endsWith('.md') ? Promise.reject(new Error('Full disk')) : create(path, data));
		expect(await plugin.saveExport(parsed, parsed.rows, false, true)).toHaveLength(1);
	});
	it('uses the reference sponsor configuration', () => {
		expect(pro.SPONSORS).toEqual({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, oneTimeMonths: 0, scope: 'read:user' });
		expect(pro.isPro()).toBe(false);
	});
	it('writes no note path in the JSON archive wrapper', () => {
		expect(archiveJson(parseAnnotations(note, 'Private.md').rows)).not.toContain('Private.md');
	});
	it('reports zero parse errors for a clean archive', () => {
		expect(errorReport(parseAnnotations(note), 1)).toContain('No parse errors.');
		expect(fileStamp(new Date('2026-10-14T00:00:00Z'))).toBe('2026-10-14T00-00-00-000Z');
	});
	it('keeps source paths literal in the Markdown error report', () => {
		const path = '![remote](https:/example.invalid/image)<img src=x>`file.md';
		const parsed = parseAnnotations('```annotation-json\n{bad}\n```', path);
		const report = errorReport(parsed, 0);
		expect(report).toContain("- `` ![remote](https:/example.invalid/image)<img src=x>`file.md `` | block 1 | line 1 | Invalid JSON.");
		expect(report.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1);
	});

});
