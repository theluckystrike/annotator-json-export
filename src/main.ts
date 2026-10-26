import { Modal, Notice, Plugin, normalizePath, type TFile } from 'obsidian';
import { createGitHubSponsors } from './license/github-obsidian';
import type { SponsorsManager } from './license/index';
import { bindPro, isPro, resetPro, SPONSORS, proNotice } from './pro';
import { AnnotatorJsonExportSettingTab } from './settings';
import { archiveJson, errorReport, fileStamp, parseAnnotations, uniquePath, type Parsed, type Row } from './parser';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

export default class AnnotatorJsonExportPlugin extends Plugin {
	pro: SponsorsManager | null = null;
	preview: ExportPreview | null = null;
	folderPicker: FolderPicker | null = null;
	private settingTab: AnnotatorJsonExportSettingTab | null = null;
	private unloaded = false;
	private previewRequest = 0;

	onload(): void {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		this.unloaded = false;
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init(); this.pro = pro; bindPro(pro);
		this.settingTab = new AnnotatorJsonExportSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.addCommand({ id: 'export-active', name: 'Preview annotation export from the active note', callback: () => void this.openActive() });
		this.addCommand({ id: 'export-folder', name: 'Export annotation notes from a folder (pro)', callback: () => {
			if (this.requirePro()) {
				this.folderPicker?.close();
				this.folderPicker = new FolderPicker(this);
				this.folderPicker.open();
			}
		} });
		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) return;
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), 6 * 60 * 60 * 1000));
		});
	}

	onunload(): void { this.unloaded = true; this.previewRequest++; this.preview?.close(); this.folderPicker?.close(); resetPro(); }

	requirePro(): boolean {
		if (isPro()) return true;
		proNotice('This is a pro feature.');
		return false;
	}

	async openActive(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') { new Notice('Open a saved Markdown annotation note first.'); return; }
		await this.openFiles([file], false);
	}

	async openFolder(folder: string): Promise<void> {
		if (!this.requirePro()) return;
		const prefix = folder === '/' ? '' : normalizePath(folder) + '/';
		const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
		await this.openFiles(files, true);
	}

	async openFiles(files: TFile[], folderMode: boolean): Promise<void> {
		if (this.unloaded) return;
		if (folderMode && !this.requirePro()) return;
		const request = ++this.previewRequest;
		const parsed: Parsed = { rows: [], errors: [], blocks: 0 };
		for (const file of files) {
			try {
				const text = await this.app.vault.read(file);
				if (this.unloaded || request !== this.previewRequest) return;
				const part = parseAnnotations(text, file.path);
				for (const row of part.rows) parsed.rows.push(row);
				for (const error of part.errors) parsed.errors.push(error);
				parsed.blocks += part.blocks;
			} catch { parsed.errors.push({ source: file.path, block: 0, line: 0, message: 'Could not read source note.' }); }
		}
		if (this.unloaded || request !== this.previewRequest) return;
		this.preview?.close();
		this.preview = new ExportPreview(this, parsed, files.length, folderMode);
		this.preview.open();
	}

	async saveExport(parsed: Parsed, rows: Row[], folderMode: boolean, dated: boolean): Promise<string[]> {
		if ((folderMode || dated) && !this.requirePro()) return [];
		if (!rows.length || rows.some((r) => !parsed.rows.includes(r))) throw new Error('Select valid preview rows first.');
		const base = dated ? `Export ${fileStamp(new Date())}` : 'Export';
		const path = uniquePath(base, 'json', (p) => this.app.vault.getAbstractFileByPath(p) !== null);
		await this.app.vault.create(path, archiveJson(rows));
		const paths = [path];
		if (dated) {
			const report = uniquePath(path.slice(0, -5) + ' errors', 'md', (p) => this.app.vault.getAbstractFileByPath(p) !== null);
			try { await this.app.vault.create(report, errorReport(parsed, rows.length)); paths.push(report); }
			catch { new Notice(`Saved ${path}. Could not create the error report.`); return paths; }
		}
		return paths;
	}
}

export class ExportPreview extends Modal {
	readonly selected = new Set<Row>();
	constructor(private owner: AnnotatorJsonExportPlugin, readonly parsed: Parsed, private noteCount: number, readonly folderMode: boolean) {
		super(owner.app); parsed.rows.forEach((r) => this.selected.add(r));
	}
	onOpen(): void {
		this.modalEl.addClass('annotator-export-modal');
		this.setTitle('Annotation export preview');
		const el = this.contentEl;
		el.createEl('p', { text: `${this.noteCount} notes · ${this.parsed.blocks} blocks · ${this.parsed.rows.length} valid rows · ${this.parsed.errors.length} errors`, cls: 'aje-counts' });
		el.createEl('p', { text: 'Check the rows to export. JSON files are created at the vault root. Source notes stay unchanged.' });
		const errors = el.createDiv({ cls: 'aje-errors' });
		for (const e of this.parsed.errors) errors.createEl('p', { text: `${e.source} · block ${e.block} · line ${e.line}: ${e.message}` });
		const list = el.createDiv({ cls: 'aje-rows' });
		for (const row of this.parsed.rows) {
			const card = list.createDiv({ cls: 'aje-row' });
			const label = card.createEl('label');
			const input = label.createEl('input', { type: 'checkbox' }); input.checked = true;
			input.setAttribute('aria-label', `Export block ${row.block} from ${row.source}`);
			input.addEventListener('change', () => { if (input.checked) this.selected.add(row); else this.selected.delete(row); update(); });
			label.createSpan({ text: `${typeof row.annotation.id === 'string' ? row.annotation.id : 'No saved ID'} · ${row.source} · block ${row.block}` });
			card.createEl('p', { text: typeof row.annotation.text === 'string' ? row.annotation.text || '(Empty comment)' : '(No comment)' });
			if (Array.isArray(row.annotation.tags)) card.createEl('p', { text: `Tags: ${row.annotation.tags.map((tag: unknown) => typeof tag === 'string' ? tag : JSON.stringify(tag)).join(', ') || '(none)'}` });
			const detail = card.createEl('details'); detail.createEl('summary', { text: 'Saved JSON with restored fields' });
			detail.createEl('pre', { text: JSON.stringify(row.annotation, null, 2) });
		}
		let acknowledged = this.parsed.errors.length === 0;
		if (!acknowledged) {
			const label = el.createEl('label', { cls: 'aje-option' });
			const input = label.createEl('input', { type: 'checkbox', cls: 'aje-ack' });
			label.createSpan({ text: 'I reviewed the errors. Export the checked valid rows only.' });
			input.addEventListener('change', () => { acknowledged = input.checked; update(); });
		}
		let dated = false;
		const label = el.createEl('label', { cls: 'aje-option' });
		const archive = label.createEl('input', { type: 'checkbox', cls: 'aje-dated' }); archive.disabled = !isPro();
		label.createSpan({ text: 'Dated local archive and Markdown error report (Pro)' });
		archive.addEventListener('change', () => { dated = archive.checked; });
		const actions = el.createDiv({ cls: 'aje-actions' });
		const status = el.createEl('p', { cls: 'aje-status', attr: { 'aria-live': 'polite' } });
		const cancel = actions.createEl('button', { text: 'Cancel' }); cancel.addEventListener('click', () => this.close());
		const save = actions.createEl('button', { text: 'Create JSON file', cls: 'mod-cta aje-save' });
		let busy = false;
		const update = () => { save.disabled = busy || !acknowledged || this.selected.size === 0; };
		update();
		save.addEventListener('click', () => {
			if (busy || !acknowledged || !this.selected.size) return;
			busy = true; update(); cancel.disabled = true;
			const rows = [...this.selected];
			void this.owner.saveExport(this.parsed, rows, this.folderMode, dated).then((paths) => {
				if (!paths.length) { busy = false; update(); cancel.disabled = false; return; }
				status.setText(`Created ${paths.join(' and ')} with ${rows.length} rows.`);
				save.setText('Export complete'); cancel.setText('Close'); cancel.disabled = false;
			}).catch((error: unknown) => {
				status.setText(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
				busy = false; update(); cancel.disabled = false;
			});
		});
	}
	onClose(): void { this.contentEl.empty(); if (this.owner.preview === this) this.owner.preview = null; }
}

class FolderPicker extends Modal {
	constructor(private owner: AnnotatorJsonExportPlugin) { super(owner.app); }
	onOpen(): void {
		this.modalEl.addClass('aje-folder-modal');
		this.setTitle('Folder export (pro)');
		this.contentEl.createEl('p', { text: 'Select a folder. Its Markdown notes and subfolders are included.' });
		const select = this.contentEl.createEl('select', { attr: { 'aria-label': 'Source folder' } });
		const folders = new Set<string>(['/']);
		for (const file of this.app.vault.getMarkdownFiles()) {
			const parts = file.path.split('/'); parts.pop();
			while (parts.length) { folders.add(parts.join('/')); parts.pop(); }
		}
		for (const folder of [...folders].sort()) select.createEl('option', { value: folder, text: folder === '/' ? 'Vault root' : folder });
		const button = this.contentEl.createEl('button', { text: 'Preview folder', cls: 'mod-cta' });
		button.addEventListener('click', () => { this.close(); void this.owner.openFolder(select.value); });
	}
	onClose(): void { this.contentEl.empty(); if (this.owner.folderPicker === this) this.owner.folderPicker = null; }
}
