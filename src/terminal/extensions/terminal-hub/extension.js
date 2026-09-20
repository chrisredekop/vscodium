// Terminal Hub: clickable command index for terminals, keeps one terminal open,
// and bootstraps Claude Code Manager (installed from Open VSX like any other extension).
// Plain JavaScript on purpose: built-in extensions without a tsconfig are copied as-is.
'use strict';

const vscode = require('vscode');

const MANAGER_ID = 'vishalguptax.claude-manager';
const MANAGER_VIEW = 'workbench.view.extension.claudeCodeManager';

function pad(n) {
	return String(n).padStart(2, '0');
}

function timeLabel(ts) {
	const d = new Date(ts);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function durationLabel(ms) {
	if (!ms || ms < 1000) {
		return '';
	}
	const s = Math.round(ms / 1000);
	if (s < 60) {
		return `${s}s`;
	}
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function oneLine(text, max = 90) {
	const t = String(text || '').replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function config() {
	return vscode.workspace.getConfiguration('terminalHub');
}

// ---------------------------------------------------------------------------
// Command index view
// ---------------------------------------------------------------------------

class CommandsProvider {
	constructor() {
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}

	refresh() {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element) {
		return element;
	}

	async getChildren(element) {
		if (!element) {
			const active = vscode.window.activeTerminal;
			const terminals = [...vscode.window.terminals].sort((a, b) => (a === active ? -1 : b === active ? 1 : 0));
			return terminals.map(t => {
				const item = new vscode.TreeItem(t.name, t === active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
				item.iconPath = new vscode.ThemeIcon('terminal');
				item.contextValue = 'terminal';
				item.terminal = t;
				return item;
			});
		}
		if (element.terminal) {
			const processId = await element.terminal.processId;
			if (typeof processId !== 'number') {
				return [];
			}
			let entries = [];
			try {
				entries = (await vscode.commands.executeCommand('workbench.action.terminal.getCommandIndex', { processId })) || [];
			} catch {
				entries = [];
			}
			if (!entries.length) {
				const item = new vscode.TreeItem('No commands detected yet', vscode.TreeItemCollapsibleState.None);
				item.iconPath = new vscode.ThemeIcon('info');
				item.tooltip = 'Commands appear once shell integration has seen a command run in this terminal.';
				return [item];
			}
			return entries.filter(e => e.commandLine && e.commandLine.trim()).reverse().map(e => this._commandItem(element.terminal, processId, e));
		}
		return [];
	}

	_commandItem(terminal, processId, e) {
		const item = new vscode.TreeItem(oneLine(e.commandLine), vscode.TreeItemCollapsibleState.None);
		const failed = typeof e.exitCode === 'number' && e.exitCode !== 0;
		const running = e.exitCode === undefined || e.exitCode === null;
		item.description = `${timeLabel(e.timestamp)}${failed ? ` · exit ${e.exitCode}` : ''}${running ? ' · running' : ''}`;
		item.iconPath = running
			? new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.blue'))
			: new vscode.ThemeIcon(failed ? 'error' : 'check', new vscode.ThemeColor(failed ? 'charts.red' : 'charts.green'));
		item.tooltip = `${e.commandLine}\n\n${e.cwd || ''}${e.duration ? `\n${durationLabel(e.duration)}` : ''}`;
		item.contextValue = 'command';
		item.entry = e;
		item.terminal = terminal;
		item.processId = processId;
		item.command = { command: 'terminalHub.revealCommand', title: 'Reveal Command in Terminal', arguments: [item] };
		return item;
	}
}

// ---------------------------------------------------------------------------
// Claude Code Manager bootstrap
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
	try {
		await vscode.commands.executeCommand(MANAGER_VIEW);
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	} catch {
		// view unavailable: keep the default layout
	}
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
	const commands = new CommandsProvider();
	const refreshCommands = () => commands.refresh();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('terminalHub.commands', commands),
		// Terminal names and shell integration arrive shortly after the terminal opens.
		vscode.window.onDidOpenTerminal(() => { refreshCommands(); setTimeout(refreshCommands, 2000); }),
		vscode.window.onDidChangeTerminalState(refreshCommands),
		vscode.window.onDidChangeActiveTerminal(refreshCommands),
		vscode.window.onDidStartTerminalShellExecution(refreshCommands),
		vscode.window.onDidEndTerminalShellExecution(refreshCommands),
		vscode.window.onDidCloseTerminal(() => {
			refreshCommands();
			// Keep the window useful: a closed last terminal gets replaced instead of leaving an empty window.
			const tabsOpen = vscode.window.tabGroups.all.some(group => group.tabs.length > 0);
			if (config().get('keepOneTerminal', true) && vscode.window.terminals.length === 0 && !tabsOpen) {
				vscode.commands.executeCommand('workbench.action.terminal.new');
			}
		}),
		vscode.commands.registerCommand('terminalHub.refresh', refreshCommands),
		vscode.commands.registerCommand('terminalHub.revealCommand', item => item && item.entry && vscode.commands.executeCommand('workbench.action.terminal.revealCommandIndex', { processId: item.processId, index: item.entry.index })),
		vscode.commands.registerCommand('terminalHub.copyCommand', item => item && item.entry && vscode.env.clipboard.writeText(item.entry.commandLine)),
		vscode.commands.registerCommand('terminalHub.rerunCommand', item => {
			if (item && item.entry && item.terminal) {
				item.terminal.show();
				item.terminal.sendText(item.entry.commandLine, true);
			}
		}),
		vscode.commands.registerCommand('terminalHub.installManager', async () => {
			const ok = await ensureManager();
			vscode.window.showInformationMessage(ok ? 'Claude Code Manager is installed.' : 'Claude Code Manager could not be installed. Check the network and the Open VSX gallery.');
			if (ok) {
				await showManager();
			}
		})
	);

	// Terminal first: start with both side bars closed unless configured otherwise.
	setTimeout(async () => {
		const present = await ensureManager();
		if (present && config().get('openManagerOnStartup', false)) {
			await showManager();
		} else if (config().get('closeSideBarsOnStartup', true)) {
			try {
				await vscode.commands.executeCommand('workbench.action.closeSidebar');
				await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			} catch {
				// layout commands unavailable: keep the restored layout
			}
		}
	}, 1500);
}

function deactivate() { }

module.exports = { activate, deactivate };
