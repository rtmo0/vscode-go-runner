# Change Log

All notable changes to the Go Target Launcher extension will be documented in this file.

## [0.2.0]

- **Run** now launches the program without debugging (`noDebug`) in the same RUN AND DEBUG panel and Debug Console as a debug session.
- **Profile** rewritten: build and run are chained so a failed compile never starts the program, the CPU profile is awaited until it is actually written (non-empty), and the pprof web UI opens on a real free port instead of the broken `localhost:0` URL.
- Removed the now-unused `go-target-launcher.runMainMode` setting.

## [0.1.0]

- Initial release.
- Run, debug and profile Go main files via CodeLens and Command Palette.
- Configurable workspace commands via the Command Palette and status bar.
