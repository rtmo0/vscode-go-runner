# Go Target Launcher

<img src="media/icon.png" alt="Go Target Launcher icon" width="128" align="right" />

Go Target Launcher is a small VS Code extension for running, debugging and profiling Go programs and keeping frequently used workspace commands in one place. It adds a clickable **Run / Debug / Profile** action next to every Go `package main` file.

## Features

- **Run** a Go main file with `go run <file>` (or build + run).
- **Debug** a Go main file via the VS Code Go debugger (`golang.Go` extension required).
- **Profile** a Go main file: captures a CPU profile and opens `go tool pprof -http` in the browser.
- Launch configured workspace commands from the **Command Palette**, the **status bar**, or a **CodeLens**.

## Configuration

Add commands to workspace or user settings:

```json
{
  "go-target-launcher.commands": [
    {
      "label": "Run example",
      "command": "go run ./cmd/main.go",
      "cwd": "${workspaceFolder}/example",
      "description": "Runs the example program"
    },
    {
      "label": "Run all tests",
      "command": "go test ./...",
      "cwd": "${workspaceFolder}/example"
    }
  ]
}
```

Each command supports:

- `label` — the name shown in Go Target Launcher.
- `command` — the shell command to run.
- `cwd` — an optional working directory; defaults to the workspace folder.
- `description` — optional text shown next to the command.

`${workspaceFolder}` can be used in `command` and `cwd`. By default, commands share one terminal. Disable `go-target-launcher.reuseTerminal` to create a separate terminal for every run.

Other settings:

- `go-target-launcher.runMainMode` — `run` (default) uses `go run <file>`; `build` builds a temporary binary and executes it.
- `go-target-launcher.profileDuration` — CPU profile duration in seconds (default `30`).
- `go-target-launcher.profileOutputDir` — where `cpu.pprof` is written (default `${workspaceFolder}/.go-profile`).

## Usage

- **Run / Debug / Profile a Go main file** — click the CodeLens next to the `package main` line, or run the matching command from the Command Palette (**Go Target Launcher: Run Main / Debug Main / Profile Main**).
- **Run a workspace command** — from the Command Palette (**Go Target Launcher: Run Command…**) or by clicking the **Go Target Launcher** entry in the status bar.
- **Configure** — use **Go Target Launcher: Configure Commands** to open the settings.

A file is treated as a Go main file when it starts with `package main` and declares `func main()`.

## How the working directory is resolved

Run, Debug and Profile all execute from the **module root** — the nearest directory containing a `go.mod`, searched upward from the main file. This makes relative config files, data directories and `os.Getwd()` based paths behave exactly like running the program from the project root, no matter where the `main.go` file lives.

> **Profile mode** compiles a test binary (`go test -c`) with a temporary test wrapper injected through `go test -overlay` (your project files are never modified), then runs that binary from the module root. It captures a CPU profile for `go-target-launcher.profileDuration` seconds and opens the interactive `go tool pprof -http` web UI.

## Development

```bash
npm install
npm run check
npm run build
```

Press `F5` to open an Extension Development Host. The [example](example) folder contains a small Go project (`example/cmd/main.go`) you can use to try Run / Debug / Profile. See [PUBLISHING.md](PUBLISHING.md) for release instructions.
