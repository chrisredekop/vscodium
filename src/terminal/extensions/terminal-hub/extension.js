// Terminal Hub: Claude Code sessions and a clickable terminal command index.
// Plain JavaScript on purpose: built-in extensions without a tsconfig are copied as-is.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const LABELS_FILE = path.join(CLAUDE_DIR, 'session-labels.json');
const STATS_FILE = path.join(CLAUDE_DIR, 'stats-cache.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && error.code === 'EPERM';
	}
}

function pad(n) {
	return String(n).padStart(2, '0');
}

function localDate(ts) {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeLabel(ts) {
	const d = new Date(ts);
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function whenLabel(ts) {
	const day = localDate(ts);
	const today = localDate(Date.now());
	const yesterday = localDate(Date.now() - 86400000);
	if (day === today) {
		return timeLabel(ts);
	}
	if (day === yesterday) {
		return `yesterday ${timeLabel(ts)}`;
	}
	const d = new Date(ts);
	return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${timeLabel(ts)}`;
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

function formatTokens(n) {
	if (n >= 1e9) {
		return `${(n / 1e9).toFixed(1)}B`;
	}
	if (n >= 1e6) {
		return `${(n / 1e6).toFixed(1)}M`;
	}
	if (n >= 1e3) {
		return `${(n / 1e3).toFixed(0)}k`;
	}
	return String(n);
}

function oneLine(text, max = 80) {
	const t = String(text || '').replace(/\s+/g, ' ').trim();
	return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function config() {
	return vscode.workspace.getConfiguration('terminalHub');
}

function quote(arg) {
	return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function openClaudeTerminal(cwd, args, name) {
	const command = [config().get('claudeCommand', 'claude'), ...args].map(quote).join(' ');
	const terminal = vscode.window.createTerminal({
		name,
		cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
		location: vscode.TerminalLocation.Editor
	});
	terminal.show();
	terminal.sendText(command, true);
}

// ---------------------------------------------------------------------------
// Claude data
// ---------------------------------------------------------------------------

class ClaudeData {
	constructor() {
		this._historyCache = { mtime: 0, sessions: [] };
	}

	runningSessions() {
		let files = [];
		try {
			files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
		} catch {
			return [];
		}
		const result = [];
		for (const file of files) {
			const data = readJson(path.join(SESSIONS_DIR, file), undefined);
			if (!data || typeof data.pid !== 'number' || !isAlive(data.pid)) {
				continue;
			}
			result.push({
				pid: data.pid,
				sessionId: data.sessionId,
				cwd: data.cwd,
				startedAt: data.startedAt,
				name: data.name,
				status: data.status,
				kind: data.kind
			});
		}
		return result.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
	}

	recentSessions() {
		let stat;
		try {
			stat = fs.statSync(HISTORY_FILE);
		} catch {
			return [];
		}
		if (stat.mtimeMs !== this._historyCache.mtime) {
			const bySession = new Map();
			const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n');
			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				let rec;
				try {
					rec = JSON.parse(line);
				} catch {
					continue;
				}
				if (!rec.sessionId) {
					continue;
				}
				const entry = bySession.get(rec.sessionId) || { sessionId: rec.sessionId, project: rec.project, first: rec.display, last: 0, count: 0 };
				// Prefer the first real prompt over slash commands such as /resume or /clear.
				if (typeof entry.first === 'string' && entry.first.trim().startsWith('/') && typeof rec.display === 'string' && !rec.display.trim().startsWith('/')) {
					entry.first = rec.display;
				}
				entry.last = Math.max(entry.last, rec.timestamp || 0);
				entry.count++;
				if (rec.project) {
					entry.project = rec.project;
				}
				bySession.set(rec.sessionId, entry);
			}
			this._historyCache = { mtime: stat.mtimeMs, sessions: [...bySession.values()].sort((a, b) => b.last - a.last) };
		}
		const labels = readJson(LABELS_FILE, {});
		return this._historyCache.sessions.map(s => ({ ...s, label: labels[s.sessionId] }));
	}

	usage() {
		const stats = readJson(STATS_FILE, undefined);
		if (!stats) {
			return undefined;
		}
		const today = localDate(Date.now());
		const week = new Set();
		for (let i = 0; i < 7; i++) {
			week.add(localDate(Date.now() - i * 86400000));
		}
		const activity = stats.dailyActivity || [];
		const tokens = stats.dailyModelTokens || [];
		const sum = (list, key, filter) => list.filter(filter).reduce((acc, e) => acc + (e[key] || 0), 0);
		const todayActivity = activity.find(e => e.date === today);
		const weekMessages = sum(activity, 'messageCount', e => week.has(e.date));
		const weekTools = sum(activity, 'toolCallCount', e => week.has(e.date));
		const weekSessions = sum(activity, 'sessionCount', e => week.has(e.date));
		const tokensByModel = {};
		for (const e of tokens.filter(e => week.has(e.date))) {
			for (const [model, n] of Object.entries(e.tokensByModel || {})) {
				tokensByModel[model] = (tokensByModel[model] || 0) + n;
			}
		}
		const todayTokens = tokens.find(e => e.date === today);
		return {
			asOf: stats.lastComputedDate,
			today: todayActivity,
			todayTokens: todayTokens ? Object.values(todayTokens.tokensByModel || {}).reduce((a, b) => a + b, 0) : 0,
			week: { messages: weekMessages, tools: weekTools, sessions: weekSessions, tokensByModel },
			totalSessions: stats.totalSessions,
			totalMessages: stats.totalMessages
		};
	}
}

// ---------------------------------------------------------------------------
// Sessions view
// ---------------------------------------------------------------------------

class SessionsProvider {
	constructor(data) {
		this.data = data;
		this._onDidChangeTreeData = new vscode.EventEmitter();
		this.onDidChangeTreeData = this._onDidChangeTreeData.event;
	}

	refresh() {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element) {
		return element;
	}

	getChildren(element) {
		if (!element) {
			return this._roots();
		}
		return element.children || [];
	}

	_roots() {
		const running = this.data.runningSessions();
		const runningIds = new Set(running.map(r => r.sessionId));
		const recent = this.data.recentSessions().filter(s => !runningIds.has(s.sessionId));
		const roots = [];

		const runningNode = new vscode.TreeItem(`Running (${running.length})`, running.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		runningNode.iconPath = new vscode.ThemeIcon('pulse');
		runningNode.contextValue = 'group';
		runningNode.children = running.map(r => this._runningItem(r));
		roots.push(runningNode);

		const projects = new Map();
		for (const s of recent) {
			const key = s.project || '(unknown)';
			if (!projects.has(key)) {
				projects.set(key, []);
			}
			projects.get(key).push(s);
		}
		const maxProjects = config().get('recentProjects', 6);
		const maxPerProject = config().get('recentSessionsPerProject', 8);
		const recentNode = new vscode.TreeItem('Recent', vscode.TreeItemCollapsibleState.Expanded);
		recentNode.iconPath = new vscode.ThemeIcon('history');
		recentNode.contextValue = 'group';
		recentNode.children = [...projects.entries()].slice(0, maxProjects).map(([project, sessions], i) => {
			const node = new vscode.TreeItem(path.basename(project) || project, i === 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
			node.description = project;
			node.iconPath = new vscode.ThemeIcon('folder');
			node.contextValue = 'project';
			node.project = project;
			node.children = sessions.slice(0, maxPerProject).map(s => this._sessionItem(s));
			return node;
		});
		roots.push(recentNode);

		const usage = this.data.usage();
		const usageNode = new vscode.TreeItem('Usage', vscode.TreeItemCollapsibleState.Collapsed);
		usageNode.iconPath = new vscode.ThemeIcon('graph');
		usageNode.contextValue = 'group';
		usageNode.children = usage ? this._usageItems(usage) : [this._info('No stats yet', 'Claude Code writes ~/.claude/stats-cache.json when /usage or /stats runs.')];
		if (usage) {
			usageNode.description = `as of ${usage.asOf}`;
		}
		roots.push(usageNode);
		return roots;
	}

	_runningItem(r) {
		const item = new vscode.TreeItem(r.name ? oneLine(r.name, 60) : path.basename(r.cwd || '') || r.sessionId, vscode.TreeItemCollapsibleState.None);
		item.description = `${r.status || r.kind || ''} · ${r.cwd || ''} · started ${whenLabel(r.startedAt)}`.replace(/^ · /, '');
		item.iconPath = new vscode.ThemeIcon(r.status === 'running' || r.status === 'busy' ? 'sync~spin' : 'circle-filled', new vscode.ThemeColor('charts.green'));
		item.tooltip = `pid ${r.pid}\nsession ${r.sessionId}\n${r.cwd || ''}`;
		item.contextValue = 'running';
		item.session = r;
		return item;
	}

	_sessionItem(s) {
		const item = new vscode.TreeItem(oneLine(s.label || s.first || s.sessionId, 70), vscode.TreeItemCollapsibleState.None);
		item.description = `${whenLabel(s.last)} · ${s.count} prompt${s.count === 1 ? '' : 's'}`;
		item.iconPath = new vscode.ThemeIcon(s.label ? 'tag' : 'comment');
		item.tooltip = `${s.first || ''}\n\nsession ${s.sessionId}\n${s.project || ''}`;
		item.contextValue = 'session';
		item.session = s;
		item.command = { command: 'terminalHub.resume', title: 'Resume Session', arguments: [item] };
		return item;
	}

	_usageItems(u) {
		const items = [];
		const t = u.today;
		items.push(this._info(`Today: ${t ? `${t.messageCount} messages · ${t.toolCallCount} tool calls · ${t.sessionCount} sessions` : 'no data'}${u.todayTokens ? ` · ${formatTokens(u.todayTokens)} tokens` : ''}`));
		items.push(this._info(`Last 7 days: ${u.week.messages} messages · ${u.week.tools} tool calls · ${u.week.sessions} sessions`));
		const models = Object.entries(u.week.tokensByModel).sort((a, b) => b[1] - a[1]);
		for (const [model, n] of models) {
			items.push(this._info(`${formatTokens(n)} tokens · ${model}`, undefined, 'symbol-misc'));
		}
		items.push(this._info(`All time: ${u.totalSessions} sessions · ${u.totalMessages} messages`));
		return items;
	}

	_info(label, tooltip, icon = 'info') {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(icon);
		item.tooltip = tooltip;
		item.contextValue = 'info';
		return item;
	}
}

// ---------------------------------------------------------------------------
// Commands view (terminal command index)
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
		const item = new vscode.TreeItem(oneLine(e.commandLine, 90), vscode.TreeItemCollapsibleState.None);
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
		item.command = { command: 'terminalHub.revealCommand', title: 'Reveal Command in Terminal', arguments: [item] };
		item.processId = processId;
		return item;
	}
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
	const data = new ClaudeData();
	const sessions = new SessionsProvider(data);
	const commands = new CommandsProvider();

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('terminalHub.sessions', sessions),
		vscode.window.registerTreeDataProvider('terminalHub.commands', commands)
	);

	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	status.command = 'terminalHub.sessions.focus';
	context.subscriptions.push(status);
	const updateStatus = () => {
		const running = data.runningSessions().length;
		status.text = `$(sparkle) Claude${running ? ` ${running}` : ''}`;
		status.tooltip = running ? `${running} Claude Code session${running === 1 ? '' : 's'} running` : 'No Claude Code session running';
		status.show();
	};

	let pending;
	const refreshSessions = () => {
		clearTimeout(pending);
		pending = setTimeout(() => {
			sessions.refresh();
			updateStatus();
		}, 300);
	};
	const refreshCommands = () => commands.refresh();

	// Watchers: Claude writes session files and history; terminals report shell executions.
	for (const target of [SESSIONS_DIR, HISTORY_FILE, LABELS_FILE, STATS_FILE]) {
		try {
			const watcher = fs.watch(target, { persistent: false }, refreshSessions);
			watcher.on('error', () => { /* file may not exist yet */ });
			context.subscriptions.push({ dispose: () => watcher.close() });
		} catch {
			// missing file or directory: refreshed by the timer below
		}
	}
	const timer = setInterval(refreshSessions, 30000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });

	context.subscriptions.push(
		vscode.window.onDidOpenTerminal(refreshCommands),
		vscode.window.onDidCloseTerminal(refreshCommands),
		vscode.window.onDidChangeActiveTerminal(refreshCommands),
		vscode.window.onDidStartTerminalShellExecution(refreshCommands),
		vscode.window.onDidEndTerminalShellExecution(refreshCommands),
		vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('terminalHub') && refreshSessions())
	);

	const skipFlag = () => config().get('skipPermissionsFlag', '--dangerously-skip-permissions');

	async function pickProject() {
		const seen = new Set();
		const picks = [];
		for (const folder of vscode.workspace.workspaceFolders || []) {
			seen.add(folder.uri.fsPath);
			picks.push({ label: folder.name, description: folder.uri.fsPath, cwd: folder.uri.fsPath });
		}
		for (const s of data.recentSessions()) {
			if (s.project && !seen.has(s.project)) {
				seen.add(s.project);
				picks.push({ label: path.basename(s.project), description: s.project, cwd: s.project });
			}
		}
		picks.push({ label: '$(folder-opened) Choose folder…', cwd: undefined, browse: true });
		const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Project folder for the new Claude session' });
		if (!pick) {
			return undefined;
		}
		if (pick.browse) {
			const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
			return uris && uris[0] ? uris[0].fsPath : undefined;
		}
		return pick.cwd;
	}

	async function newSession(skip) {
		const cwd = await pickProject();
		if (cwd === undefined && !(vscode.workspace.workspaceFolders || []).length) {
			return;
		}
		openClaudeTerminal(cwd, skip ? [skipFlag()] : [], 'claude');
	}

	function resume(item, skip) {
		const s = item && item.session;
		if (!s) {
			return;
		}
		openClaudeTerminal(s.project, ['--resume', s.sessionId, ...(skip ? [skipFlag()] : [])], `claude · ${oneLine(s.label || s.first || s.sessionId, 30)}`);
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('terminalHub.newSession', () => newSession(false)),
		vscode.commands.registerCommand('terminalHub.newSessionSkip', () => newSession(true)),
		vscode.commands.registerCommand('terminalHub.resume', item => resume(item, false)),
		vscode.commands.registerCommand('terminalHub.resumeSkip', item => resume(item, true)),
		vscode.commands.registerCommand('terminalHub.copySessionId', item => item && item.session && vscode.env.clipboard.writeText(item.session.sessionId)),
		vscode.commands.registerCommand('terminalHub.refresh', () => { refreshSessions(); refreshCommands(); }),
		vscode.commands.registerCommand('terminalHub.revealCommand', item => item && item.entry && vscode.commands.executeCommand('workbench.action.terminal.revealCommandIndex', { processId: item.processId, index: item.entry.index })),
		vscode.commands.registerCommand('terminalHub.copyCommand', item => item && item.entry && vscode.env.clipboard.writeText(item.entry.commandLine)),
		vscode.commands.registerCommand('terminalHub.rerunCommand', item => {
			if (item && item.entry && item.terminal) {
				item.terminal.show();
				item.terminal.sendText(item.entry.commandLine, true);
			}
		})
	);

	updateStatus();
}

function deactivate() { }

module.exports = { activate, deactivate };
