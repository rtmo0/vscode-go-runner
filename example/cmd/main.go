package main

import (
	"fmt"
	"time"
)

func busyWork() {
	start := time.Now()
	for time.Since(start) < 5*time.Second {
		_ = fmt.Sprintf("processing %d", time.Now().UnixNano())
	}
}

func main() {
	fmt.Println("Hello from Go Target Launcher example")
	fmt.Println("Starting busy work (5s)…")
	busyWork()
	fmt.Println("Done.")
}
