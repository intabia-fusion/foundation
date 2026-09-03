// Copyright © 2026 Intabia Fusion.
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/bubbletea"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

const usage = `gh-picker - TUI and CLI for porting commits between forks

  gh-picker [-branch upstream/develop] [-outgoing]   interactive TUI
  gh-picker report [flags]                           commits to port for a path group
  gh-picker packages [flags]                         per-package divergence summary
  gh-picker skip|unskip <hash>...                    mark commits as not-to-port
`

// chdirToRepoRoot makes every git call and every repo-relative path in the tool
// behave the same regardless of where it was launched from. Without it, path
// limited diffs silently come back empty and commits look already applied.
func chdirToRepoRoot() error {
	out, err := GitExec("rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	return os.Chdir(strings.TrimSpace(out))
}

func run() error {
	if err := chdirToRepoRoot(); err != nil {
		return err
	}
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "report":
			return runReport(os.Args[2:])
		case "packages":
			return runPackages(os.Args[2:])
		case "applied":
			return runApplied(os.Args[2:])
		case "skip":
			return runSkip(os.Args[2:], false)
		case "unskip":
			return runSkip(os.Args[2:], true)
		case "help", "-h", "--help":
			fmt.Print(usage)
			return nil
		}
	}

	upstreamBranch := flag.String("branch", "upstream/develop", "Branch to compare with (default: upstream/develop)")
	outgoing := flag.Bool("outgoing", false, "Start in outgoing mode (HEAD -> upstream)")
	flag.Parse()

	m := initialModelWithBranch(*upstreamBranch)
	if *outgoing {
		m.mode = ModeOutgoing
	}
	p := tea.NewProgram(m, tea.WithAltScreen())
	_, err := p.Run()
	return err
}
