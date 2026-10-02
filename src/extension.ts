import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
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
  // Run from the module root so relative config files, data dirs and `os.Getwd()`
  // based paths resolve the same way they do when launching from the project root.
  const cwd = main.moduleRoot || findModuleRoot(main.dir);
  const mode = vscode.workspace.getConfiguration('go-target-launcher').get<string>('runMainMode', 'run');
  const file = shellQuote(main.filePath);
  const terminal = getTerminal(`Run ${main.name}`, cwd);
  terminal.show(true);

  if (mode === 'build') {
    const binPath = path.join(cwd, `.${main.name.replace(/\.[^.]*$/, '')}-${process.pid}`);
    const build = `go build -o "${binPath}" ${file} && "${binPath}"`;
    terminal.sendText(build, true);
  } else {
    terminal.sendText(`go run ${file}`, true);
  }
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

  const terminal = vscode.window.createTerminal({
    name: `Profile ${main.name}`,
    cwd: moduleRoot
  });
  terminal.show(true);

  // Package path relative to the module root.
  const pkgRel = path.relative(moduleRoot, main.dir);
  const packageArg = pkgRel ? `./${pkgRel.split(path.sep).join('/')}` : '.';
  const binPath = path.join(os.tmpdir(), `go-target-launcher-${process.pid}-profile.bin`);

  // Two steps:
  //  1. Compile a test binary (`go test -c`) using the injected wrapper.
  //  2. Run that binary from the module root. Running from the module root makes
  //     `os.Getwd()` and relative paths behave exactly like a normal run, which
  //     matters for apps that look up config/data relative to the module root.
  const commands = [
    `go test -c -o "${binPath}" -overlay="${overlayPath}" ${packageArg}`,
    `"${binPath}" -test.run "^TestGoTargetLauncherProfile$" -test.count=1 -test.timeout=${duration + 30}s -test.cpuprofile="${profilePath}"`
  ];
  for (const command of commands) {
    terminal.sendText(command, true);
  }

  // Give the test time to produce the profile, then open the pprof web UI and
  // clean up the temporary wrapper and overlay files.
  await delay(duration * 1000 + 8000);

  const pprofTerminal = vscode.window.createTerminal({
    name: `pprof ${main.name}`,
    cwd: moduleRoot
  });
  pprofTerminal.show(true);
  pprofTerminal.sendText(`go tool pprof -http=localhost:0 "${profilePath}"`, true);

  await Promise.allSettled([
    fs.promises.unlink(wrapperPath),
    fs.promises.unlink(overlayPath),
    fs.promises.unlink(binPath)
  ]);
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

function shellQuote(value: string): string {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
