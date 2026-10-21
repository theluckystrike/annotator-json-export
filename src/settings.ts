import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import { PRO_UI } from './pro';
import type AnnotatorJsonExportPlugin from './main';
import { helloSettingItems } from './hello/settings';

export class AnnotatorJsonExportSettingTab extends PluginSettingTab {
	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], private owner: AnnotatorJsonExportPlugin) { super(app, owner); }
	getSettingDefinitions(): SettingDefinitionItem[] {
		// The product rows, then the "More from NoteMods" card (packages/hello).
		return [...this.productSettingDefinitions(), ...helloSettingItems()];
	}

	productSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{ name: 'Local export', desc: 'Export creates new files at the vault root. Source notes stay unchanged. Select rows in the preview before export.' },
			...(this.owner.pro ? sponsorsSettingItems(this.owner.pro, PRO_UI) : []),
		];
	}
}
