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
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"text/tabwriter"
)

// pathGroups maps a group name to the pathspecs of the packages it covers.
// "card" and "process" are the ones we must keep in sync with upstream; the
// rest of the tree is decided case by case via `packages`.
var pathGroups = map[string][]string{
	"card": {
		"plugins/card", "plugins/card-assets", "plugins/card-resources",
		"models/card", "models/server-card",
		"server-plugins/card", "server-plugins/card-resources",
	},
	"process": {
		"plugins/process", "plugins/process-assets", "plugins/process-resources",
		"models/process", "models/server-process",
		"server-plugins/process", "server-plugins/process-resources",
		"services/process",
	},
}

func groupPaths(name string) ([]string, error) {
	if name == "all" {
		return nil, nil
	}
	var paths []string
	for _, g := range strings.Split(name, ",") {
		g = strings.TrimSpace(g)
		if g == "" {
			continue
		}
		p, ok := pathGroups[g]
		if !ok {
			return nil, fmt.Errorf("unknown group %q (known: card, process, all)", g)
		}
		paths = append(paths, p...)
	}
	return paths, nil
}

// logEntry is one commit plus the files it touches.
type logEntry struct {
	Hash    string   `json:"hash"`
	Short   string   `json:"short"`
	Date    string   `json:"date"`
	Author  string   `json:"author"`
	Subject string   `json:"subject"`
	Files   []string `json:"files,omitempty"`
	State   string   `json:"state"`
	Ratio   string   `json:"ratio,omitempty"`
}

// gitLogEntries runs one `git log` and parses commits with their file lists.
// side is "--right-only" (upstream -> us) or "--left-only" (us -> upstream).
func gitLogEntries(localRef, remoteRef, side string, paths []string, cherry, withFiles bool) ([]logEntry, error) {
	args := []string{"log", "--no-merges", side, "--reverse",
		"--format=\x1e%H\x1f%h\x1f%as\x1f%an\x1f%s", localRef + "..." + remoteRef}
	if cherry {
		args = append(args, "--cherry-pick")
	}
	if withFiles {
		args = append(args, "--name-only")
	}
	if len(paths) > 0 {
		args = append(args, "--")
		// :(top) so pathspecs stay repo-relative regardless of the cwd
		for _, p := range paths {
			args = append(args, ":(top)"+strings.TrimSpace(p))
		}
	}
	out, err := GitExec(args...)
	if err != nil {
		return nil, err
	}
	return parseLogEntries(out), nil
}

// parseLogEntries splits `git log --format=RS...US...` output into commits,
// with any trailing --name-only lines attached as Files.
func parseLogEntries(out string) []logEntry {
	var entries []logEntry
	for _, block := range strings.Split(out, "\x1e") {
		if strings.TrimSpace(block) == "" {
			continue
		}
		lines := strings.Split(strings.TrimRight(block, "\n"), "\n")
		head := strings.Split(lines[0], "\x1f")
		if len(head) < 5 {
			continue
		}
		e := logEntry{Hash: head[0], Short: head[1], Date: head[2], Author: head[3], Subject: head[4]}
		for _, f := range lines[1:] {
			if f = strings.TrimSpace(f); f != "" {
				e.Files = append(e.Files, f)
			}
		}
		entries = append(entries, e)
	}
	return entries
}

// annotate fills State from the applied cache and the ignore store.
func annotate(entries []logEntry) []logEntry {
	cache, _ := LoadAppliedCache()
	store, _ := LoadIgnoreStore()
	for i := range entries {
		h := entries[i].Hash
		switch {
		case cache != nil && cache.Has(h):
			entries[i].State = "applied"
		case store != nil && store.Has(KindIncoming, h):
			entries[i].State = "skipped"
		default:
			entries[i].State = "todo"
		}
	}
	return entries
}

// contentCheck upgrades "todo" entries whose content is in fact already in HEAD,
// which is the only way to spot ports that were squashed or reworked on our side
// (patch-id and subject matching both miss those). Read-only, so parallel-safe.
func contentCheck(entries []logEntry) {
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i := range entries {
		if entries[i].State != "todo" {
			continue
		}
		wg.Add(1)
		go func(e *logEntry) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			c := Commit{Hash: e.Hash, Subject: e.Subject}
			CheckCherryPickedOne(&c)
			switch {
			case c.CherryPicked:
				e.State = "applied"
			case c.Partial:
				e.State = "partial"
				e.Ratio = c.AppliedRatio
			}
		}(&entries[i])
	}
	wg.Wait()
}

func runReport(argv []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	remote := fs.String("branch", "upstream/develop", "remote ref to compare with")
	local := fs.String("local", "HEAD", "local ref")
	group := fs.String("group", "card,process", "path group: card, process, all, or comma list")
	paths := fs.String("paths", "", "explicit pathspecs (comma separated), overrides -group")
	author := fs.String("author", "", "keep only commits whose author contains this substring")
	state := fs.String("state", "todo", "filter by state: todo, applied, skipped, any")
	noCherry := fs.Bool("no-cherry", false, "do not drop commits whose patch already exists locally")
	files := fs.Bool("files", false, "list touched files per commit")
	check := fs.Bool("check", false, "content-check every commit against HEAD (slow, catches squashed/reworked ports)")
	asJSON := fs.Bool("json", false, "JSON output")
	fs.Parse(argv)

	specs, err := groupPaths(*group)
	if err != nil {
		return err
	}
	if *paths != "" {
		specs = strings.Split(*paths, ",")
	}

	entries, err := gitLogEntries(*local, *remote, "--right-only", specs, !*noCherry, true)
	if err != nil {
		return err
	}
	entries = annotate(entries)

	// Author filter first: the content check is expensive, no point running it on
	// commits that get dropped anyway.
	if *author != "" {
		filtered := entries[:0]
		for _, e := range entries {
			if strings.Contains(strings.ToLower(e.Author), strings.ToLower(*author)) {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}
	if *check {
		contentCheck(entries)
	}

	kept := entries[:0]
	for _, e := range entries {
		if *state != "any" && e.State != *state {
			continue
		}
		if !*files {
			e.Files = nil
		}
		kept = append(kept, e)
	}

	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(kept)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(w, "STATE\tHASH\tDATE\tAUTHOR\tSUBJECT")
	for _, e := range kept {
		state := e.State
		if e.Ratio != "" {
			state += " " + e.Ratio
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", state, e.Short, e.Date, e.Author, e.Subject)
		for _, f := range e.Files {
			fmt.Fprintf(w, "\t\t\t\t  %s\n", f)
		}
	}
	w.Flush()
	fmt.Printf("\n%d commit(s) to port, oldest first. Pick with: git cherry-pick -x <hash>\n", len(kept))
	return nil
}

type pkgStat struct {
	Package  string `json:"package"`
	Incoming int    `json:"incoming"`
	Outgoing int    `json:"outgoing"`
}

// pkgOf collapses a file path to its owning package directory (two segments,
// which is how this monorepo is laid out: plugins/card, models/process, ...).
func pkgOf(file string) string {
	parts := strings.Split(file, "/")
	if len(parts) >= 2 {
		return parts[0] + "/" + parts[1]
	}
	return parts[0]
}

func runPackages(argv []string) error {
	fs := flag.NewFlagSet("packages", flag.ExitOnError)
	remote := fs.String("branch", "upstream/develop", "remote ref to compare with")
	local := fs.String("local", "HEAD", "local ref")
	noCherry := fs.Bool("no-cherry", false, "do not drop commits whose patch already exists locally")
	min := fs.Int("min", 1, "hide packages with fewer than N incoming commits")
	asJSON := fs.Bool("json", false, "JSON output")
	fs.Parse(argv)

	stats := map[string]*pkgStat{}
	for _, s := range []struct {
		side string
		add  func(*pkgStat)
	}{
		{"--right-only", func(p *pkgStat) { p.Incoming++ }},
		{"--left-only", func(p *pkgStat) { p.Outgoing++ }},
	} {
		entries, err := gitLogEntries(*local, *remote, s.side, nil, !*noCherry, true)
		if err != nil {
			return err
		}
		for _, e := range entries {
			seen := map[string]bool{}
			for _, f := range e.Files {
				p := pkgOf(f)
				if seen[p] {
					continue
				}
				seen[p] = true
				if stats[p] == nil {
					stats[p] = &pkgStat{Package: p}
				}
				s.add(stats[p])
			}
		}
	}

	list := make([]pkgStat, 0, len(stats))
	for _, v := range stats {
		if v.Incoming >= *min {
			list = append(list, *v)
		}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Incoming != list[j].Incoming {
			return list[i].Incoming > list[j].Incoming
		}
		return list[i].Package < list[j].Package
	})

	if *asJSON {
		return json.NewEncoder(os.Stdout).Encode(list)
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 2, 2, ' ', 0)
	fmt.Fprintln(w, "INCOMING\tOUTGOING\tPACKAGE")
	for _, s := range list {
		fmt.Fprintf(w, "%d\t%d\t%s\n", s.Incoming, s.Outgoing, s.Package)
	}
	return w.Flush()
}

// runApplied marks hashes as applied in ~/.gh-picker/<repo>.json. Needed when a
// pick was conflict-resolved: the resulting patch-id differs from upstream's, so
// `git log --cherry-pick` can no longer recognise it.
func runApplied(argv []string) error {
	if len(argv) == 0 {
		return fmt.Errorf("usage: gh-picker applied <hash>...")
	}
	cache, err := LoadAppliedCache()
	if err != nil {
		return err
	}
	for _, ref := range argv {
		out, err := GitExec("rev-parse", ref)
		if err != nil {
			return err
		}
		cache.Mark(strings.TrimSpace(out))
	}
	if err := cache.Save(); err != nil {
		return err
	}
	fmt.Printf("%d hash(es) marked applied\n", len(argv))
	return nil
}

// runSkip adds or removes hashes from the incoming ignore list, so `report`
// stops offering commits we decided not to port.
func runSkip(argv []string, remove bool) error {
	if len(argv) == 0 {
		return fmt.Errorf("usage: gh-picker skip|unskip <hash>...")
	}
	store, err := LoadIgnoreStore()
	if err != nil {
		return err
	}
	for _, ref := range argv {
		out, err := GitExec("rev-parse", ref)
		if err != nil {
			return err
		}
		hash := strings.TrimSpace(out)
		if remove {
			store.Remove(KindIncoming, hash)
		} else {
			store.Add(KindIncoming, hash)
		}
	}
	if err := store.Save(); err != nil {
		return err
	}
	fmt.Printf("%d hash(es) %s\n", len(argv), map[bool]string{true: "unskipped", false: "skipped"}[remove])
	return nil
}
