import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import AnnotatorJsonExportPlugin, { ExportPreview } from '../src/main';
import { parseAnnotations } from '../src/parser';
import manifest from '../manifest.json';
import * as pro from '../src/pro';
import * as obsidian from 'obsidian';

vi.mock('obsidian', async (original) => ({ ...await original<typeof import('obsidian')>(), requestUrl: vi.fn() }));

const note = '```annotation-json\n{"text":"Saved"}\n```\n^row';
function makePlugin(files: Record<string, string> = {}) {
	return new AnnotatorJsonExportPlugin(App.createConfigured__({ files }) as never, manifest as never);
}
afterEach(() => { vi.restoreAllMocks(); pro.resetPro(); });

describe('Parser review cases', () => {
	it('keeps a Markdown quote in a plain marked comment', () => {
		const parsed = parseAnnotations('```annotation-json\n{}\n```\n%%COMMENT%%\n> Keep this quote\n%%TAGS%%\n^row');
		expect(parsed.rows[0]!.annotation.text).toBe('> Keep this quote');
	});
	it('does not take fields from an unrelated code fence', () => {
		const parsed = parseAnnotations('```annotation-json\n{"id":"saved","text":"Saved"}\n```\n\n```text\n%%COMMENT%%\nWrong comment\n^wrong\n```');
		expect(parsed.rows[0]!.annotation).toEqual({ id: 'saved', text: 'Saved' });
	});
	it('keeps IDs and markers inside a fenced comment as text', () => {
		const comment = 'Example:\n```text\n^example\n%%TAGS%%\n#example\n```';
		const parsed = parseAnnotations('```annotation-json\n{}\n```\n%%COMMENT%%\n' + comment + '\n%%TAGS%%\n#real\n^row');
		expect(parsed.rows[0]!.annotation).toEqual({ id: 'row', text: comment, tags: ['real'] });
	});
	it.each(['```', '~~~'])('accepts a longer closing fence for %s', (fence) => {
		const parsed = parseAnnotations(fence + 'annotation-json\n{}\n' + fence + fence[0] + '\n^row');
		expect(parsed.errors).toEqual([]);
		expect(parsed.rows[0]!.annotation.id).toBe('row');
	});
	it('keeps combining marks in Unicode tags', () => {
		const parsed = parseAnnotations('```annotation-json\n{}\n```\n%%TAGS%%\n#cafe\u0301 #nghie\u0323n\n^row');
		expect(parsed.rows[0]!.annotation.tags).toEqual(['cafe\u0301', 'nghie\u0323n']);
	});
	it.each(['9007199254740993', '1e400'])('reports unsupported numeric data instead of changing %s', (number) => {
		const parsed = parseAnnotations('```annotation-json\n{"vendor":{"number":' + number + '}}\n```');
		expect(parsed.rows).toHaveLength(0);
		expect(parsed.errors[0]!.message).toBe('Numeric field is outside the supported range.');
	});
});

describe('Preview review cases', () => {
	it('makes no requests while signed out, including the refresh interval', async () => {
		vi.useFakeTimers();
		const plugin = makePlugin({ 'Source.md': note });
		const http = vi.mocked(obsidian.requestUrl); http.mockClear();
		try {
			vi.spyOn(plugin.app.workspace, 'onLayoutReady').mockImplementation((callback) => { callback(); });
			plugin.load();
			await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
			await plugin.pro!.refreshNow();
			const parsed = parseAnnotations(note);
			expect(await plugin.saveExport(parsed, parsed.rows, false, false)).toEqual(['Export.json']);
			expect(http).not.toHaveBeenCalled();
		} finally { plugin.unload(); vi.useRealTimers(); }
	});
	it('shows an empty vault with no selected rows and no output', async () => {
		const plugin = makePlugin();
		await plugin.openFiles([], false);
		try {
			expect(plugin.preview!.contentEl.querySelector('.aje-counts')!.textContent).toBe('0 notes · 0 blocks · 0 valid rows · 0 errors');
			expect(plugin.preview!.contentEl.querySelector<HTMLButtonElement>('.aje-save')!.disabled).toBe(true);
			expect(plugin.app.vault.getFiles()).toHaveLength(0);
		} finally { plugin.preview?.close(); }
	});
	it('includes subfolders and excludes folders with a similar name', async () => {
		vi.spyOn(pro, 'isPro').mockReturnValue(true);
		const plugin = makePlugin({ 'Research/First.md': note, 'Research/Sub/Second.md': note, 'Research/Empty.md': 'No rows', 'ResearchOther/Third.md': note });
		await plugin.openFolder('Research');
		try {
			expect(plugin.preview!.parsed.rows.map((row) => row.source)).toEqual(['Research/First.md', 'Research/Sub/Second.md']);
			expect(plugin.preview!.contentEl.querySelector('.aje-counts')!.textContent).toBe('3 notes · 2 blocks · 2 valid rows · 0 errors');
		} finally { plugin.preview?.close(); }
	});
	it('collects a large note without the function argument limit', async () => {
		// The large text comes from vault.read only: the mock metadata parser overflows the stack on it (Linux CI).
		const plugin = makePlugin({ 'Large.md': note });
		const large = ('```annotation-json\n{}\n```\n^row\n').repeat(150000);
		vi.spyOn(plugin.app.vault, 'read').mockResolvedValue(large);
		vi.spyOn(ExportPreview.prototype, 'open').mockImplementation(() => undefined);
		await plugin.openFiles([plugin.app.vault.getFileByPath('Large.md')!], false);
		try {
			expect(plugin.preview!.parsed.rows.length).toBe(150000);
			expect(plugin.preview!.parsed.errors.length).toBe(0);
		} finally { plugin.preview?.close(); }
	});
	it('does not reopen a preview after unload during a read', async () => {
		const plugin = makePlugin({ 'Source.md': note });
		let finish!: (text: string) => void;
		vi.spyOn(plugin.app.vault, 'read').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
		const pending = plugin.openFiles([plugin.app.vault.getFileByPath('Source.md')!], false);
		plugin.onunload(); finish(note); await pending;
		expect(plugin.preview).toBeNull();
		plugin.preview?.close();
	});
	it('keeps the newest preview when an older read finishes last', async () => {
		const plugin = makePlugin({ 'Old.md': note, 'New.md': note });
		let finish!: (text: string) => void;
		vi.spyOn(plugin.app.vault, 'read').mockImplementation((file) => file.path === 'Old.md' ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(note));
		const old = plugin.openFiles([plugin.app.vault.getFileByPath('Old.md')!], false);
		await plugin.openFiles([plugin.app.vault.getFileByPath('New.md')!], false);
		finish(note); await old;
		try { expect(plugin.preview!.parsed.rows[0]!.source).toBe('New.md'); }
		finally { plugin.preview?.close(); }
	});
	it('does not register an interval after unload before layout ready', () => {
		const plugin = makePlugin();
		let ready!: () => void;
		vi.spyOn(plugin.app.workspace, 'onLayoutReady').mockImplementation((callback) => { ready = callback; });
		const interval = vi.spyOn(window, 'setInterval');
		plugin.onload(); plugin.onunload(); ready();
		try { expect(interval).not.toHaveBeenCalled(); }
		finally { for (const result of interval.mock.results) window.clearInterval(result.value as number); }
	});
	it('shows JSON tag objects without calling their toString fields', () => {
		const plugin = makePlugin();
		const parsed = parseAnnotations('```annotation-json\n{"tags":[{"toString":null}]}\n```');
		const preview = new ExportPreview(plugin, parsed, 1, false);
		try {
			expect(() => preview.onOpen()).not.toThrow();
			expect(preview.contentEl.textContent).toContain('{"toString":null}');
		} finally { preview.onClose(); }
	});
	it('reports the saved row count if selection changes during a write', async () => {
		const plugin = makePlugin();
		let finish!: (paths: string[]) => void;
		const save = vi.spyOn(plugin, 'saveExport').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
		const preview = new ExportPreview(plugin, parseAnnotations(note), 1, false);
		preview.onOpen();
		try {
			preview.contentEl.querySelector<HTMLButtonElement>('.aje-save')!.click();
			const input = preview.contentEl.querySelector<HTMLInputElement>('.aje-row input')!;
			input.checked = false; input.dispatchEvent(new Event('change'));
			finish(['Export.json']); await vi.waitFor(() => expect(preview.contentEl.querySelector('.aje-status')!.textContent).toBe('Created Export.json with 1 rows.'));
			expect(save.mock.calls[0]![1]).toHaveLength(1);
		} finally { preview.onClose(); }
	});
});
