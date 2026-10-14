import { describe, expect, it } from 'vitest';
import vectors from './vectors/annotator-json-export.json';
import { parseAnnotations, uniquePath } from '../src/parser';
import { App } from 'obsidian-test-mocks/obsidian';
import AnnotatorJsonExportPlugin from '../src/main';
import manifest from '../manifest.json';
function makePlugin(files: Record<string, string>) { return new AnnotatorJsonExportPlugin(App.createConfigured__({ files }) as never, manifest as never); }

describe('Golden vectors', () => {
	it('has at least twenty acceptance vectors', () => expect(vectors.cases.length).toBeGreaterThanOrEqual(20));
	for (const c of vectors.cases) it(c.name, async () => {
		const args = c.args as unknown[];
		let actual: unknown;
		if (c.fn === 'uniquePath') {
			const [base, extension, existing] = args as [string, string, string[]];
			actual = uniquePath(base, extension, (p) => existing.includes(p));
		} else if (c.fn === 'saveScenario') {
			const scenario = args[0] as { existing: string[]; cancel: boolean };
			const source = '```annotation-json\n{}\n```\n^row';
			const plugin = makePlugin({ 'Source.md': source, ...Object.fromEntries(scenario.existing.map((path) => [path, 'existing'])) });
			const parsed = parseAnnotations(source);
			let created: string[] = [];
			if (scenario.cancel) {
				await plugin.openFiles([plugin.app.vault.getFileByPath('Source.md')!], false);
				plugin.preview!.close();
				expect(plugin.app.vault.getFileByPath('Export.json')).toBeNull();
			} else created = await plugin.saveExport(parsed, parsed.rows, false, false);
			actual = { created, unchanged: await plugin.app.vault.read(plugin.app.vault.getFileByPath('Source.md')!) === source };
		} else actual = parseAnnotations(...args as [string, string]);
		expect(actual).toEqual(c.expected);
	});
});
