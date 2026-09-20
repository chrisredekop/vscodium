// Terminal Hub: keeps one terminal open, shows Claude Code Manager on the right,
// pastes clipboard images as files (Alt+V), offers an input editor for long prompts
// and runs YAML workflows with {{placeholders}}.
// Plain JavaScript on purpose: built-in extensions without a tsconfig are copied as-is.
'use strict';

const vscode = require('vscode');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const MANAGER_ID = 'vishalguptax.claude-manager';
// The manager contributes two containers: one for the activity bar and, on VS Code >= 1.106,
// one for the secondary side bar. We prefer the right side and fall back to the left.
const MANAGER_VIEWS = ['workbench.view.extension.claudeCodeManagerSecondary', 'workbench.view.extension.claudeCodeManager'];
const INPUT_FILES = /^terminal-input\.(ps1|sh|md)$/;

function config() {
	return vscode.workspace.getConfiguration('terminalHub');
}

function quotePath(p) {
	return /\s/.test(p) ? `"${p}"` : p;
}

function isInputTab(tab) {
	const uri = tab.input && tab.input.uri;
	return !!(uri && INPUT_FILES.test(path.basename(uri.fsPath)));
}

function run(file, args) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr || error.message));
			} else {
				resolve(String(stdout));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Claude Code Manager
// ---------------------------------------------------------------------------

async function ensureManager() {
	if (vscode.extensions.getExtension(MANAGER_ID)) {
		return true;
	}
	if (!config().get('installManager', true)) {
		return false;
	}
	try {
		await vscode.commands.executeCommand('workbench.extensions.installExtension', MANAGER_ID);
		return !!vscode.extensions.getExtension(MANAGER_ID);
	} catch (error) {
		console.warn('[terminalHub] installing Claude Code Manager failed', error);
		return false;
	}
}

async function showManager() {
	// The manager's right-hand view is gated on a context key that its activate() sets.
	// Opening the container before activation would show an empty side bar.
	const ext = vscode.extensions.getExtension(MANAGER_ID);
	if (ext && !ext.isActive) {
		try {
			await ext.activate();
		} catch (error) {
			console.warn('[terminalHub] activating Claude Code Manager failed', error);
		}
	}
	for (const view of MANAGER_VIEWS) {
		try {
			await vscode.commands.executeCommand(view);
			return true;
		} catch {
			// container not contributed in this version: try the next one
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Sending text to the active terminal
// ---------------------------------------------------------------------------

let lastTerminal;

// Focuses an existing terminal wherever it lives (editor area or panel). The built-in
// "terminal.focus" command would open a new panel terminal next to terminal editors.
async function focusTerminal() {
	const terminal = vscode.window.activeTerminal || lastTerminal || vscode.window.terminals[0];
	if (terminal) {
		terminal.show(false);
	} else {
		await vscode.commands.executeCommand('workbench.action.terminal.new');
	}
}

// Goes through the terminal's paste path so bracketed paste applies: multi-line text
// reaches programs such as Claude Code as one paste instead of several Enter presses.
async function pasteToTerminal(terminal, text, execute) {
	terminal.show(true);
	const previous = await vscode.env.clipboard.readText();
	await vscode.env.clipboard.writeText(text);
	try {
		await vscode.commands.executeCommand('workbench.action.terminal.paste');
	} finally {
		await vscode.env.clipboard.writeText(previous);
	}
	if (execute) {
		terminal.sendText('', true);
	}
}

// ---------------------------------------------------------------------------
// Alt+V: clipboard image or copied files as path
// ---------------------------------------------------------------------------

async function pasteImage() {
	const terminal = vscode.window.activeTerminal;
	if (!terminal || process.platform !== 'win32') {
		return vscode.commands.executeCommand('workbench.action.terminal.paste');
	}
	const dir = path.join(os.tmpdir(), 'codium-term-images');
	fs.mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
	const file = path.join(dir, `clipboard-${stamp}.png`);
	// Windows PowerShell 5.1 with an STA thread can read images from the clipboard; pwsh 7 cannot.
	const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const script = [
		'Add-Type -AssemblyName System.Windows.Forms',
		'Add-Type -AssemblyName System.Drawing',
		'$img = [System.Windows.Forms.Clipboard]::GetImage()',
		`if ($img) { $img.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'IMAGE' } ` +
		"elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) { 'FILES'; [System.Windows.Forms.Clipboard]::GetFileDropList() } " +
		"else { 'NONE' }"
	].join('; ');
	let lines;
	try {
		lines = (await run(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-Command', script])).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	} catch (error) {
		console.warn('[terminalHub] clipboard read failed', error);
		lines = ['NONE'];
	}
	if (lines[0] === 'IMAGE') {
		terminal.sendText(quotePath(file) + ' ', false);
	} else if (lines[0] === 'FILES') {
		terminal.sendText(lines.slice(1).map(quotePath).join(' ') + ' ', false);
	} else {
		await vscode.commands.executeCommand('workbench.action.terminal.paste');
	}
}

// ---------------------------------------------------------------------------
// Input editor: a real editor below the terminal, Ctrl+Enter sends its text
// ---------------------------------------------------------------------------

function inputFileFor(terminal, storageDir) {
	const name = (terminal && terminal.name || '').toLowerCase();
	const ext = name.includes('claude') ? 'md' : name.includes('bash') ? 'sh' : 'ps1';
	return vscode.Uri.file(path.join(storageDir, `terminal-input.${ext}`));
}

function findInputTab() {
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			if (isInputTab(tab)) {
				return tab;
			}
		}
	}
	return undefined;
}

async function toggleInputEditor(storageDir) {
	const open = findInputTab();
	if (open) {
		await vscode.window.tabGroups.close(open);
		await focusTerminal();
		return;
	}
	const uri = inputFileFor(vscode.window.activeTerminal, storageDir);
	fs.mkdirSync(storageDir, { recursive: true });
	if (!fs.existsSync(uri.fsPath)) {
		fs.writeFileSync(uri.fsPath, '');
	}
	const doc = await vscode.workspace.openTextDocument(uri);
	await vscode.window.showTextDocument(doc, { preview: false });
	if (vscode.window.tabGroups.all.length === 1) {
		await vscode.commands.executeCommand('workbench.action.moveEditorToBelowGroup');
		await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 1, groups: [{ size: 0.7 }, { size: 0.3 }] });
	}
}

async function sendInput(execute) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}
	const doc = editor.document;
	const selected = editor.selection.isEmpty ? '' : doc.getText(editor.selection);
	const text = (selected || doc.getText()).replace(/\s+$/, '');
	if (!text) {
		return;
	}
	const terminal = vscode.window.activeTerminal || lastTerminal || vscode.window.terminals[0];
	if (!terminal) {
		vscode.window.showInformationMessage('No terminal to send to.');
		return;
	}
	await pasteToTerminal(terminal, text, execute);
	if (execute && !selected) {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), '');
		await vscode.workspace.applyEdit(edit);
		await doc.save();
	}
	await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
}

// ---------------------------------------------------------------------------
// Workflows: YAML files with {{placeholders}}
// ---------------------------------------------------------------------------

const WORKFLOW_TEMPLATE = `# Terminal workflow. Placeholders {{name}} are asked for when the workflow runs.
name: Git commit
description: Stage everything and commit with a message
command: |
  git add -A
  git commit -m "{{message}}"
arguments:
  - name: message
    description: Commit message
    default_value: wip
`;

function workflowsDir() {
	const configured = config().get('workflowsDir', '');
	return configured ? configured.replace(/^~(?=$|[\\/])/, os.homedir()) : path.join(os.homedir(), '.vscodium-term', 'workflows');
}

function unquote(value) {
	const v = value.trim();
	return /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
}

// Minimal YAML subset: top-level "key: value", "command: |" block scalars and an
// "arguments:" list of "- name/description/default_value" items.
function parseWorkflow(text) {
	const lines = text.split(/\r?\n/);
	const wf = { name: '', description: '', command: '', arguments: [] };
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith('#')) {
			i++;
			continue;
		}
		const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
		if (!m) {
			i++;
			continue;
		}
		const key = m[1];
		const value = m[2].trim();
		i++;
		if (value === '|' || value === '|-' || value === '>') {
			const block = [];
			while (i < lines.length && (/^\s/.test(lines[i]) || !lines[i].trim())) {
				block.push(lines[i]);
				i++;
			}
			while (block.length && !block[block.length - 1].trim()) {
				block.pop();
			}
			const indent = Math.min(...block.filter(l => l.trim()).map(l => /^\s*/.exec(l)[0].length));
			wf[key] = block.map(l => l.slice(indent)).join(value === '>' ? ' ' : '\n');
		} else if (key === 'arguments' && !value) {
			while (i < lines.length && /^\s+(-|\S)/.test(lines[i])) {
				const item = /^\s+-\s*(.*)$/.exec(lines[i]);
				if (item) {
					wf.arguments.push({});
					lines[i] = '    ' + item[1];
					continue;
				}
				const kv = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(lines[i]);
				if (kv && wf.arguments.length) {
					wf.arguments[wf.arguments.length - 1][kv[1]] = unquote(kv[2]);
				}
				i++;
			}
		} else {
			wf[key] = unquote(value);
		}
	}
	return wf;
}

function loadWorkflows() {
	const dir = workflowsDir();
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir)
		.filter(f => /\.ya?ml$/i.test(f))
		.map(f => {
			try {
				const wf = parseWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'));
				wf.file = path.join(dir, f);
				wf.name = wf.name || f.replace(/\.ya?ml$/i, '');
				return wf;
			} catch {
				return undefined;
			}
		})
		.filter(wf => wf && wf.command);
}

async function newWorkflow() {
	const dir = workflowsDir();
	fs.mkdirSync(dir, { recursive: true });
	let file = path.join(dir, 'new-workflow.yaml');
	for (let n = 2; fs.existsSync(file); n++) {
		file = path.join(dir, `new-workflow-${n}.yaml`);
	}
	fs.writeFileSync(file, WORKFLOW_TEMPLATE);
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false });
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runWorkflow() {
	const workflows = loadWorkflows();
	if (!workflows.length) {
		const choice = await vscode.window.showInformationMessage(`No workflows in ${workflowsDir()}.`, 'Create one');
		if (choice) {
			await newWorkflow();
		}
		return;
	}
	const pick = await vscode.window.showQuickPick(workflows.map(wf => ({ label: wf.name, description: wf.description, detail: wf.command.split('\n')[0], wf })), { placeHolder: 'Run workflow', matchOnDescription: true, matchOnDetail: true });
	if (!pick) {
		return;
	}
	const wf = pick.wf;
	const names = [];
	for (const arg of wf.arguments) {
		if (arg.name && !names.includes(arg.name)) {
			names.push(arg.name);
		}
	}
	for (const m of wf.command.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
		if (!names.includes(m[1])) {
			names.push(m[1]);
		}
	}
	let command = wf.command;
	for (const name of names) {
		const arg = wf.arguments.find(a => a.name === name) || {};
		const value = await vscode.window.showInputBox({ title: `${wf.name}: ${name}`, prompt: arg.description || '', value: arg.default_value || '' });
		if (value === undefined) {
			return;
		}
		command = command.replace(new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g'), value);
	}
	const terminal = vscode.window.activeTerminal || lastTerminal || vscode.window.terminals[0] || vscode.window.createTerminal();
	await pasteToTerminal(terminal, command, false);
	await focusTerminal();
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
	const storageDir = context.globalStorageUri.fsPath;

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTerminal(t => { if (t) { lastTerminal = t; } }),
		vscode.window.onDidCloseTerminal(t => {
			if (lastTerminal === t) {
				lastTerminal = undefined;
			}
			// Keep the window useful: a closed last terminal gets replaced instead of leaving an empty window.
			const tabsOpen = vscode.window.tabGroups.all.some(group => group.tabs.some(tab => !isInputTab(tab)));
			if (config().get('keepOneTerminal', true) && vscode.window.terminals.length === 0 && !tabsOpen) {
				vscode.commands.executeCommand('workbench.action.terminal.new');
			}
		}),
		vscode.commands.registerCommand('terminalHub.showManager', async () => {
			if (await ensureManager()) {
				await showManager();
			} else {
				vscode.window.showInformationMessage('Claude Code Manager could not be installed. Check the network and the Open VSX gallery.');
			}
		}),
		vscode.commands.registerCommand('terminalHub.pasteImage', pasteImage),
		vscode.commands.registerCommand('terminalHub.toggleInputEditor', () => toggleInputEditor(storageDir)),
		vscode.commands.registerCommand('terminalHub.sendInput', () => sendInput(true)),
		vscode.commands.registerCommand('terminalHub.insertInput', () => sendInput(false)),
		vscode.commands.registerCommand('terminalHub.runWorkflow', runWorkflow),
		vscode.commands.registerCommand('terminalHub.newWorkflow', newWorkflow),
		vscode.commands.registerCommand('terminalHub.openWorkflowsFolder', async () => {
			fs.mkdirSync(workflowsDir(), { recursive: true });
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(workflowsDir()));
		})
	);

	// Terminal first: terminal in the middle, manager on the right, nothing on the left.
	setTimeout(async () => {
		const present = await ensureManager();
		// Dragging the manager once created a second copy of it. Reset the layout a single time
		// so the manager sits where its own contribution puts it.
		if (!context.globalState.get('viewLocationsReset')) {
			try {
				await vscode.commands.executeCommand('workbench.action.resetViewLocations');
			} catch {
				// command unavailable: keep the layout
			}
			await context.globalState.update('viewLocationsReset', true);
		}
		try {
			await vscode.commands.executeCommand('workbench.action.closeSidebar');
			if (present && config().get('openManagerOnStartup', true)) {
				await showManager();
			} else {
				await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
			}
			await focusTerminal();
		} catch {
			// layout commands unavailable: keep the restored layout
		}
	}, 1500);
}

function deactivate() { }

module.exports = { activate, deactivate };
