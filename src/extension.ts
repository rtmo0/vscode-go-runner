import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as vscode from 'vscode';

interface RunnerCommand {
  label: string;
  command: string;
  cwd?: string;
  description?: string;
}

interface GoMain {
  name: string;
  filePath: string;
  dir: string;
  moduleRoot: string;
  range: vscode.Range;
}

const GO_LANGUAGE = 'go';

let sharedTerminal: vscode.Terminal | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

class GoCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.languageId !== GO_LANGUAGE || document.uri.scheme !== 'file') {
      return [];
    }

    return getGoMains(document).flatMap((main) => {
      const common = {
        name: main.name,
        filePath: main.filePath,
        dir: main.dir,
        moduleRoot: main.moduleRoot
      };
      return [
        codeLens(main.range, 'go-target-launcher.runMain', 'Run', common),
        codeLens(main.range, 'go-target-launcher.debugMain', 'Debug', common),
        codeLens(main.range, 'go-target-launcher.profileMain', 'Profile', common)
      ];
    });
  }
}

function codeLens(range: vscode.Range, command: string, label: string, args: object): vscode.CodeLens {
  const lens = new vscode.CodeLens(range);
  lens.command = {
    command,
    title: `$(play) ${label}`,
    arguments: [args]
  };
  return lens;
}

export function activate(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'Go Target Launcher';
  statusBarItem.command = 'go-target-launcher.runCommand';
  statusBarItem.tooltip = 'Run a Go Target Launcher command';
  statusBarItem.show();
  updateStatusBar();

  context.subscriptions.push(
    statusBarItem,
    vscode.languages.registerCodeLensProvider(
      { language: GO_LANGUAGE, scheme: 'file' },
      new GoCodeLensProvider()
    ),
    vscode.commands.registerCommand('go-target-launcher.runMain', (main?: GoMain) => {
      const target = main ?? getActiveGoMain();
      if (target) {
        runMain(target);
      }
    }),
    vscode.commands.registerCommand('go-target-launcher.debugMain', (main?: GoMain) => {
      const target = main ?? getActiveGoMain();
      if (target) {
        debugMain(target);
      }
    }),
    vscode.commands.registerCommand('go-target-launcher.profileMain', (main?: GoMain) => {
      const target = main ?? getActiveGoMain();
      if (target) {
        profileMain(target);
      }
    }),
    vscode.commands.registerCommand('go-target-launcher.configure', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'go-target-launcher.commands')
    ),
    vscode.commands.registerCommand('go-target-launcher.runCommand', async (command?: RunnerCommand) => {
      const selected = command ?? await pickCommand();
      if (selected) {
        runInTerminal(selected);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('go-target-launcher.commands')) {
        updateStatusBar();
      }
      if (event.affectsConfiguration('go-target-launcher.reuseTerminal') && !shouldReuseTerminal()) {
        sharedTerminal = undefined;
      }
    }),
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === sharedTerminal) {
        sharedTerminal = undefined;
      }
    })
  );
}

export function deactivate(): void {
  sharedTerminal = undefined;
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

// ---------------------------------------------------------------------------
// Go main file discovery
// ---------------------------------------------------------------------------

function getGoMains(document: vscode.TextDocument): GoMain[] {
  const filePath = document.uri.fsPath;
  const dir = path.dirname(filePath);
  const text = document.getText();

  // A `package main` file is a candidate only when it declares `func main()`.
  if (!/\bpackage\s+main\b/.test(text) || !/\bfunc\s+main\s*\(/.test(text)) {
    return [];
  }

  const mainLineIndex = findFuncMainLine(document);
  const mainLine = document.lineAt(mainLineIndex);
  // Place the CodeLens on the `func main()` line itself.
  return [{
    name: path.basename(filePath),
    filePath,
    dir,
    moduleRoot: findModuleRoot(dir),
    range: new vscode.Range(mainLine.range.start, mainLine.range.end)
  }];
}

// Walks up from `startDir` and returns the directory containing the first
// `go.mod` file. Falls back to `startDir` when no module root is found, so the
// extension works even for files outside a Go module.
function findModuleRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, 'go.mod'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

function findFuncMainLine(document: vscode.TextDocument): number {
  const text = document.getText();
  const match = /\bfunc\s+main\s*\(/.exec(text);
  if (!match) {
    return 0;
  }
  const offset = match.index;
  return document.positionAt(offset).line;
}

function getActiveGoMain(): GoMain | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== GO_LANGUAGE || editor.document.uri.scheme !== 'file') {
    return undefined;
  }
  const mains = getGoMains(editor.document);
  return mains[0];
}

// ---------------------------------------------------------------------------
// Run mode
// ---------------------------------------------------------------------------

function runMain(main: GoMain): void {
  // Run through the debug infrastructure (`noDebug`) so the program shows up in
  // the same RUN AND DEBUG panel, Debug Console and floating toolbar that Debug
  // mode uses — but it runs straight through without stopping on breakpoints.
  const cwd = main.moduleRoot || findModuleRoot(main.dir);
  vscode.debug.startDebugging(undefined, {
    type: 'go',
    name: `Run ${main.name}`,
    request: 'launch',
    noDebug: true,
    mode: 'debug',
    program: main.filePath,
    cwd
  }).then(
    () => undefined,
    async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showErrorMessage(
        `Failed to start the Go run session: ${message}`,
        'Install Go extension'
      );
      if (action === 'Install Go extension') {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', 'golang.Go');
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Debug mode
// ---------------------------------------------------------------------------

function debugMain(main: GoMain): void {
  const cwd = main.moduleRoot || findModuleRoot(main.dir);
  vscode.debug.startDebugging(undefined, {
    type: 'go',
    name: `Debug ${main.name}`,
    request: 'launch',
    mode: 'debug',
    program: main.filePath,
    cwd
  }).then(
    () => undefined,
    async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const action = await vscode.window.showErrorMessage(
        `Failed to start the Go debug session: ${message}`,
        'Install Go extension'
      );
      if (action === 'Install Go extension') {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', 'golang.Go');
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Profile mode
// ---------------------------------------------------------------------------

const PROFILE_WRAPPER = `package main

import (
	"testing"
	"time"
)

func TestGoTargetLauncherProfile(t *testing.T) {
	done := make(chan struct{})
	go func() {
		main()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(\${DURATION_SECONDS} * time.Second):
	}
}
`;

async function profileMain(main: GoMain): Promise<void> {
  const moduleRoot = main.moduleRoot || findModuleRoot(main.dir);
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(main.dir));
  const profileDirRaw = vscode.workspace.getConfiguration('go-target-launcher')
    .get<string>('profileOutputDir', '${workspaceFolder}/.go-profile');
  const profileDir = resolveVariables(profileDirRaw, workspaceFolder) ?? main.dir;
  const duration = Math.max(1, vscode.workspace.getConfiguration('go-target-launcher')
    .get<number>('profileDuration', 30));

  await fs.promises.mkdir(profileDir, { recursive: true });

  // The CPU profile is captured by `go test` (a plain `go build` binary ignores
  // profile flags). We inject a test wrapper through `go test -overlay`, so the
  // user's files stay untouched.
  const wrapperPath = path.join(os.tmpdir(), `go-target-launcher-${process.pid}-profile_test.go`);
  const virtualWrapperPath = path.join(main.dir, 'go-target-launcher-profile_test.go');
  const overlayPath = path.join(os.tmpdir(), `go-target-launcher-${process.pid}-overlay.json`);
  const profilePath = path.join(profileDir, 'cpu.pprof');

  const wrapperSource = PROFILE_WRAPPER.replace('${DURATION_SECONDS}', String(duration));
  await fs.promises.writeFile(wrapperPath, wrapperSource, 'utf8');
  await fs.promises.writeFile(
    overlayPath,
    JSON.stringify({ Replace: { [virtualWrapperPath]: wrapperPath } }),
    'utf8'
  );

  // Remove any leftover profile from a previous run so the wait below is
  // deterministic and reflects only this run.
  await fs.promises.unlink(profilePath).catch(() => undefined);

  const terminal = vscode.window.createTerminal({
    name: `Profile ${main.name}`,
    cwd: moduleRoot
  });
  terminal.show(true);

  // Package path relative to the module root.
  const pkgRel = path.relative(moduleRoot, main.dir);
  const packageArg = pkgRel ? `./${pkgRel.split(path.sep).join('/')}` : '.';
  const binPath = path.join(os.tmpdir(), `go-target-launcher-${process.pid}-profile.bin`);

  // Build and run in a single chained command so the run only starts when the
  // compile succeeded. Running the test binary from the module root makes
  // `os.Getwd()` and relative paths behave exactly like a normal run, which
  // matters for apps that look up config/data relative to the module root.
  const command = [
    `go test -c -o "${binPath}" -overlay="${overlayPath}" ${packageArg}`,
    `&& "${binPath}" -test.run "^TestGoTargetLauncherProfile$" -test.count=1 -test.timeout=${duration + 30}s -test.cpuprofile="${profilePath}"`
  ].join(' ');
  terminal.sendText(command, true);

  // Wait for the profile to actually exist (the test may take up to
  // `duration` + the test binary's own runtime, and never appears if the
  // compile or run failed).
  const profileReady = await waitForFile(profilePath, duration * 1000 + 45000);
  if (!profileReady) {
    vscode.window.showErrorMessage(
      `No CPU profile was produced. Check the "Profile ${main.name}" terminal for errors.`
    );
    await cleanupProfileFiles(wrapperPath, overlayPath, binPath);
    return;
  }

  // `go tool pprof -http=localhost:0` prints a dead "localhost:0" URL, so pick
  // a concrete free port and serve the web UI on it.
  const port = await findFreePort();
  const pprofTerminal = vscode.window.createTerminal({
    name: `pprof ${main.name}`,
    cwd: moduleRoot
  });
  pprofTerminal.show(true);
  pprofTerminal.sendText(`go tool pprof -http=localhost:${port} "${profilePath}"`, true);

  await cleanupProfileFiles(wrapperPath, overlayPath, binPath);
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Go creates cpu.pprof empty at test start and fills it only when the
      // test finishes, so require a non-empty file before treating the profile
      // as ready.
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 0) {
        return true;
      }
    } catch {
      // File does not exist yet.
    }
    await delay(1000);
  }
  return false;
}

async function cleanupProfileFiles(...paths: string[]): Promise<void> {
  await Promise.allSettled(paths.map((p) => fs.promises.unlink(p)));
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to allocate a free port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Workspace commands
// ---------------------------------------------------------------------------

function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }
  const count = getCommands().length;
  if (count === 0) {
    statusBarItem.text = '$(go-to-file) Go Target Launcher';
    statusBarItem.tooltip = 'No Go Target Launcher commands configured. Click to configure.';
  } else {
    statusBarItem.text = `$(go-to-file) Go Target Launcher (${count})`;
    statusBarItem.tooltip = `Run one of ${count} Go Target Launcher command(s)`;
  }
}

function getCommands(): RunnerCommand[] {
  const configured = vscode.workspace.getConfiguration('go-target-launcher').get<RunnerCommand[]>('commands', []);
  return configured.filter((item) =>
    typeof item?.label === 'string' && item.label.trim().length > 0 &&
    typeof item.command === 'string' && item.command.trim().length > 0
  );
}

async function pickCommand(): Promise<RunnerCommand | undefined> {
  const commands = getCommands();
  if (commands.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'No Go Target Launcher commands are configured.',
      'Configure'
    );
    if (action === 'Configure') {
      await vscode.commands.executeCommand('go-target-launcher.configure');
    }
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    commands.map((command) => ({
      label: command.label,
      description: command.description,
      detail: command.command,
      command
    })),
    { placeHolder: 'Select a command to run', matchOnDescription: true, matchOnDetail: true }
  );
  return picked?.command;
}

function runInTerminal(definition: RunnerCommand): void {
  const workspaceFolder = getWorkspaceFolder();
  const cwd = resolveVariables(definition.cwd ?? workspaceFolder?.uri.fsPath, workspaceFolder);
  const command = resolveVariables(definition.command, workspaceFolder) ?? definition.command;
  const terminal = getTerminal(definition.label, cwd);
  terminal.show(true);
  terminal.sendText(command, true);
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : vscode.workspace.workspaceFolders?.[0];
}

function resolveVariables(value: string | undefined, folder: vscode.WorkspaceFolder | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return value.replaceAll('${workspaceFolder}', folder?.uri.fsPath ?? '');
}

function getTerminal(label: string, cwd: string | undefined): vscode.Terminal {
  if (shouldReuseTerminal()) {
    sharedTerminal ??= vscode.window.createTerminal({ name: 'Go Target Launcher', cwd });
    return sharedTerminal;
  }

  return vscode.window.createTerminal({ name: `Go Target Launcher: ${label}`, cwd });
}

function shouldReuseTerminal(): boolean {
  return vscode.workspace.getConfiguration('go-target-launcher').get<boolean>('reuseTerminal', true);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
