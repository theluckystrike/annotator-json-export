import { browser, expect } from '@wdio/globals';
import { obsidianPage } from 'wdio-obsidian-service';
import { readFileSync } from 'node:fs';
import { pluginId, reloadPlugin } from './load';

const fixture = readFileSync('tests/fixtures/testfile2.md', 'utf8');
const source = '>```annotation-json\n>{"text":"old","target":[{"selector":[{"type":"TextQuoteSelector","exact":"日本語 quote","vendor":7}]}],"custom":{"keep":true}}\n>```\n>%%COMMENT%%\n>New comment\n>%%TAGS%%\n>#research, #draft\n^current-id\n';
const bad = '\n>```annotation-json\n>{broken}\n>```\n^broken-id';

async function preview(path: string, content: string): Promise<void> {
	await obsidianPage.write(path, content);
	await obsidianPage.openFile(path);
	await browser.waitUntil(async () => browser.executeObsidian(({ app }, name) => app.workspace.getActiveFile()?.path === name, path), { timeout: 10000 });
	await browser.executeObsidianCommand(`${pluginId}:export-active`);
	await browser.$('.annotator-export-modal .aje-counts').waitForExist();
}
async function closePreview(): Promise<void> {
	await browser.$('.annotator-export-modal .aje-actions button').click();
	await browser.$('.annotator-export-modal').waitForExist({ reverse: true });
}
async function read(path: string): Promise<string | null> {
	return browser.executeObsidian(async ({ app }, name) => {
		const file = app.vault.getFileByPath(name);
		return file ? await app.vault.read(file) : null;
	}, path);
}
async function create(): Promise<void> {
	await browser.$('.annotator-export-modal .aje-save').click();
	await browser.waitUntil(async () => (await browser.$('.annotator-export-modal .aje-status').getText()).startsWith('Created '), { timeout: 10000 });
}
async function proOn(): Promise<void> {
	await browser.executeObsidian(async ({ app }, id) => {
		interface DemoPlugin { pro: { opts: { http: (req: unknown) => Promise<unknown> }; refreshNow(): Promise<unknown> } }
		const p = (app as unknown as { plugins: { plugins: Record<string, DemoPlugin> } }).plugins.plugins[id]!;
		p.pro.opts.http = async () => ({ status: 200, json: { data: { viewer: { login: 'demo-reader' }, user: { sponsorshipForViewerAsSponsor: { isActive: true, isOneTimePayment: false, tier: { name: '$5 a month', monthlyPriceInCents: 500 } } } } } });
		app.secretStorage.setSecret(`${id}-github-token`, 'gho_' + '0'.repeat(36));
		await p.pro.refreshNow();
	}, pluginId);
}

describe(`${pluginId} desktop export`, function () {
	it('loads and reloads without console errors', async () => {
		expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
	});
	it('reads the four fixture IDs and the second current comment', async () => {
		await preview('Fixture.md', fixture);
		expect(await browser.$('.aje-counts').getText()).toContain('4 valid rows · 0 errors');
		const labels = await browser.$$('.aje-row label');
		const values = [];
		for (const label of labels) values.push(await label.getText());
		for (const id of ['ghrcuqkctcn', '0lj0rg85p8y9', 'chill', 'pt6evw5pjd']) expect(values.join('\n')).toContain(id);
		const rows = await browser.$$('.aje-row');
		expect(await rows[1]!.getText()).toContain('testie ball');
		await closePreview();
		expect(await read('Fixture.md')).toBe(fixture);
	});
	it('cancel creates no file', async () => {
		await preview('Cancel.md', source); await closePreview();
		expect(await read('Export.json')).toBeNull();
		expect(await read('Cancel.md')).toBe(source);
	});
	it('keeps existing files and restores current fields and unknown JSON', async () => {
		await obsidianPage.write('Export.json', 'existing archive');
		await preview('Current.md', source); await create();
		const archive = JSON.parse((await read('Export (2).json'))!) as { rows: Record<string, unknown>[]; total: number };
		expect(archive.total).toBe(1);
		expect(archive.rows[0]).toEqual({ id: 'current-id', text: 'New comment', tags: ['research', 'draft'], target: [{ selector: [{ type: 'TextQuoteSelector', exact: '日本語 quote', vendor: 7 }] }], custom: { keep: true } });
		expect(await read('Export.json')).toBe('existing archive');
		expect(await read('Current.md')).toBe(source); await closePreview();
	});
	it('requires error review then exports the selected valid page note', async () => {
		const page = '```annotation-json\n{}\n```\n%%COMMENT%%\nPage comment\n%%TAGS%%\n#page\n^page-id';
		await preview('Errors.md', page + bad);
		expect(await browser.$('.aje-errors').getText()).toContain('block 2');
		expect(await browser.$('.aje-save').isEnabled()).toBe(false);
		await browser.$('.aje-ack').click(); await create();
		const archive = JSON.parse((await read('Export (3).json'))!) as { rows: unknown[] };
		expect(archive.rows).toEqual([{ id: 'page-id', text: 'Page comment', tags: ['page'] }]);
		expect(await read('Errors.md')).toBe(page + bad); await closePreview();
	});
	it('requires a selected row and keeps Pro off while signed out', async () => {
		await preview('Selection.md', source);
		expect(await browser.$('.aje-dated').isEnabled()).toBe(false);
		await browser.$('.aje-row input').click();
		expect(await browser.$('.aje-save').isEnabled()).toBe(false); await closePreview();
		await browser.executeObsidianCommand(`${pluginId}:export-folder`);
		expect(await browser.$('.annotator-export-modal').isExisting()).toBe(false);
	});
	it('exports a Pro folder with subfolders and writes a dated report', async () => {
		await obsidianPage.write('E2EFolder/First.md', source);
		await obsidianPage.write('E2EFolder/Sub/Second.md', '```annotation-json\n{"text":"Second"}\n```\n^second');
		await obsidianPage.write('E2EFolder/Bad.md', '>```annotation-json\n>{bad}\n>```');
		await proOn();
		await browser.executeObsidianCommand(`${pluginId}:export-folder`);
		await browser.$('.aje-folder-modal select').waitForExist();
		await browser.$('.aje-folder-modal select').selectByAttribute('value', 'E2EFolder');
		await browser.$('.aje-folder-modal button').click();
		await browser.$('.aje-counts').waitForExist();
		expect(await browser.$('.aje-counts').getText()).toContain('3 notes · 3 blocks · 2 valid rows · 1 errors');
		await browser.$('.aje-ack').click(); await browser.$('.aje-dated').click(); await create();
		const paths = await browser.executeObsidian(({ app }) => app.vault.getFiles().map((f) => f.path).filter((p) => p.startsWith('Export 20')));
		expect(paths).toHaveLength(2);
		const jsonPath = paths.find((p) => p.endsWith('.json'))!;
		const reportPath = paths.find((p) => p.endsWith('.md'))!;
		expect(JSON.parse((await read(jsonPath))!).total).toBe(2);
		expect(await read(reportPath)).toContain('` E2EFolder/Bad.md ` | block 1 | line 1 | Invalid JSON.'); await closePreview();
	});
	it('closes the folder picker when the plugin reloads', async () => {
		await proOn();
		await browser.executeObsidianCommand(`${pluginId}:export-folder`);
		await browser.$('.aje-folder-modal').waitForExist();
		expect(await reloadPlugin(pluginId)).toEqual({ enabled: true, reloaded: true, errors: [] });
		await browser.$('.aje-folder-modal').waitForExist({ reverse: true });
		await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { pro: { signOut(): void } }> } }).plugins.plugins[id]!;
			p.pro.signOut();
		}, pluginId);
	});
	it('exports a plain Markdown comment with fenced IDs and markers intact', async () => {
		const comment = '> Keep the quote\n```text\n^example\n%%TAGS%%\n#example\n```';
		const content = '```annotation-json\n{"text":"old"}\n````\n%%COMMENT%%\n' + comment + '\n%%TAGS%%\n#cafe\u0301\n^review-row';
		await preview('Review.md', content); await create();
		expect(JSON.parse((await read('Export (4).json'))!).rows).toEqual([{ id: 'review-row', text: comment, tags: ['cafe\u0301'] }]);
		expect(await read('Review.md')).toBe(content); await closePreview();
	});

});
