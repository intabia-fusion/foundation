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
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Commit represents a git commit
type Commit struct {
	Hash         string
	ShortHash    string
	Subject      string
	Author       string
	Date         string
	CherryPicked bool
	Partial      bool     // True if only some files/lines are already present in HEAD
	AppliedRatio string   // e.g. "3/5 files" when Partial
	MissingFiles []string // files not yet applied to HEAD (set when Partial)
	HasConflict  bool     // True if cherry-pick would have conflicts
	Diff         string   // Full diff of the commit
}

// GitExec runs a git command and returns the output
func GitExec(args ...string) (string, error) {
	return GitExecIn("", args...)
}

// GitExecIn runs a git command in the given directory (empty = current)
func GitExecIn(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	// Without this, read-only commands still try to refresh the index and race
	// each other on index.lock when the content check runs in parallel, which
	// silently turns into "no diff" and a false "already applied".
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	var out bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s failed: %v (stderr: %s)",
			strings.Join(args, " "), err, stderr.String())
	}

	return out.String(), nil
}

// GetCurrentBranch returns the current git branch
func GetCurrentBranch() (string, error) {
	out, err := GitExec("rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}

// GetCommitsFromUpstream returns commits from upstream/develop that are not in current branch
func GetCommitsFromUpstream(upstreamBranch string) ([]Commit, error) {
	// Get commits in upstream but not in current branch
	// Format: hash|short|subject|author|date
	format := "%H|%h|%s|%an|%ad"
	out, err := GitExec("log", "HEAD.."+upstreamBranch, "--format="+format, "--date=short")
	if err != nil {
		return nil, err
	}

	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return []Commit{}, nil
	}

	commits := make([]Commit, 0, len(lines))
	for _, line := range lines {
		parts := strings.SplitN(line, "|", 5)
		if len(parts) < 5 {
			continue
		}

		commits = append(commits, Commit{
			Hash:      parts[0],
			ShortHash: parts[1],
			Subject:   parts[2],
			Author:    parts[3],
			Date:      parts[4],
		})
	}

	return commits, nil
}

// CheckCherryPickedOne inspects a single commit and fills CherryPicked/Partial/HasConflict
func CheckCherryPickedOne(commit *Commit) {
	if _, err := GitExec("merge-base", "--is-ancestor", commit.Hash, "HEAD"); err == nil {
		commit.CherryPicked = true
		commit.Partial = false
		commit.HasConflict = false
		return
	}
	if out, _ := GitExec("log", "HEAD", "--format=%s", "--grep="+commit.Subject, "-1"); strings.TrimSpace(out) == commit.Subject {
		commit.CherryPicked = true
		commit.Partial = false
		commit.HasConflict = false
		return
	}
	files, err := GetCommitFiles(commit.Hash)
	if err != nil || len(files) == 0 {
		commit.CherryPicked = false
		commit.HasConflict = false
		return
	}
	applied := 0
	total := 0
	conflictAny := false
	var missing []string
	for _, f := range files {
		state := checkFileApplied(commit.Hash, f)
		switch state {
		case fileApplied:
			applied++
			total++
		case fileMissing:
			total++
			missing = append(missing, f)
		case fileConflict:
			total++
			conflictAny = true
			missing = append(missing, f)
		case fileSkip:
			// binary/rename/etc — ignore in ratio
		}
	}
	if total == 0 {
		commit.CherryPicked = true
		commit.HasConflict = false
		return
	}
	if applied == total {
		commit.CherryPicked = true
		commit.Partial = false
		commit.HasConflict = false
		commit.AppliedRatio = ""
		return
	}
	if applied > 0 {
		commit.CherryPicked = false
		commit.Partial = true
		commit.HasConflict = conflictAny
		commit.AppliedRatio = fmt.Sprintf("%d/%d files", applied, total)
		commit.MissingFiles = missing
		return
	}
	commit.CherryPicked = false
	commit.Partial = false
	commit.HasConflict = conflictAny
}

type fileState int

const (
	fileMissing fileState = iota
	fileApplied
	fileConflict
	fileSkip
)

// checkFileApplied checks whether the changes to a single file in `hash` are
// already present in HEAD. Works even if the commit was squashed/combined on
// upstream: we compare added/removed lines against current HEAD content.
func checkFileApplied(hash, file string) fileState {
	patch, err := GitExec("diff", "--no-color", hash+"^.."+hash, "--", file)
	if err != nil || strings.TrimSpace(patch) == "" {
		return fileSkip
	}
	if strings.Contains(patch, "Binary files") || strings.Contains(patch, "GIT binary patch") {
		return fileSkip
	}
	// Reverse first: if the patch reverses cleanly, the end-state is already in
	// HEAD -> applied. Must precede the forward check because pure insertions
	// often forward-apply cleanly too (the anchor context still exists), which
	// would falsely report missing.
	if runApplyCheck(patch, true) {
		return fileApplied
	}
	// Forward applies cleanly and reverse did not -> not yet applied.
	if runApplyCheck(patch, false) {
		return fileMissing
	}
	// Fallback: inspect added/removed lines vs HEAD content of file.
	headContent, err := GitExec("show", "HEAD:"+file)
	if err != nil {
		// file doesn't exist in HEAD — can't be applied
		return fileMissing
	}
	added, removed := extractChangedLines(patch)
	if len(added) == 0 && len(removed) == 0 {
		return fileSkip
	}
	headNorm := normalizeWS(headContent)
	addedHit := 0
	for _, ln := range added {
		if strings.Contains(headNorm, normalizeWS(ln)) {
			addedHit++
		}
	}
	removedHit := 0
	for _, ln := range removed {
		if strings.Contains(headNorm, normalizeWS(ln)) {
			removedHit++
		}
	}
	// All added lines present AND all removed lines gone -> applied
	addedTotal := len(added)
	if addedHit == addedTotal && removedHit == 0 {
		return fileApplied
	}
	// Fuzzy threshold: most added lines present -> applied. We ignore the
	// removed-lines metric because short removed lines (e.g. a single call
	// expression) frequently reoccur elsewhere in the file and cause false
	// negatives. The added-lines signal is the reliable one.
	if addedTotal > 0 {
		addedRatio := float64(addedHit) / float64(addedTotal)
		if addedRatio >= 0.85 {
			return fileApplied
		}
	}
	_ = removedHit
	// Otherwise: genuinely absent or conflicting
	if addedHit > 0 {
		return fileConflict
	}
	return fileMissing
}

// normalizeWS collapses runs of whitespace (incl. newlines) to single spaces
// so that reformatted code still matches line-level contains checks.
func normalizeWS(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return b.String()
}

func runApplyCheck(patch string, reverse bool) bool {
	args := []string{"apply", "--check"}
	if reverse {
		args = append(args, "--reverse")
	}
	args = append(args, "-")
	cmd := exec.Command("git", args...)
	cmd.Stdin = strings.NewReader(patch)
	var stderr bytes.Buffer
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	cmd.Stderr = &stderr
	return cmd.Run() == nil
}

// extractChangedLines returns non-trivial added and removed lines from a
// unified diff (skips file headers and empty/whitespace-only lines).
func extractChangedLines(patch string) (added, removed []string) {
	for _, ln := range strings.Split(patch, "\n") {
		if strings.HasPrefix(ln, "+++") || strings.HasPrefix(ln, "---") {
			continue
		}
		if strings.HasPrefix(ln, "+") {
			s := strings.TrimSpace(ln[1:])
			if len(s) >= 3 {
				added = append(added, s)
			}
			continue
		}
		if strings.HasPrefix(ln, "-") {
			s := strings.TrimSpace(ln[1:])
			if len(s) >= 3 {
				removed = append(removed, s)
			}
		}
	}
	return
}

// CheckCherryPicked batch variant (no progress reporting)
func CheckCherryPicked(commits []Commit, upstreamBranch string) ([]Commit, error) {
	for i := range commits {
		CheckCherryPickedOne(&commits[i])
	}
	return commits, nil
}

// CherryPick performs cherry-pick of the given commit
func CherryPick(hash string) error {
	_, err := GitExec("cherry-pick", hash)
	return err
}

// CherryPickIn performs cherry-pick in the given worktree directory
func CherryPickIn(dir, hash string) error {
	_, err := GitExecIn(dir, "cherry-pick", hash)
	return err
}

// WorktreeAdd creates a new worktree at path with a new branch based on startPoint
func WorktreeAdd(path, branch, startPoint string) error {
	_, err := GitExec("worktree", "add", "-b", branch, path, startPoint)
	return err
}

// CherryPickPaths applies only given paths from commit and creates a commit
// reusing the original author/message. Returns error if nothing changed or git fails.
func CherryPickPaths(hash string, paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("no paths to apply from %s", hash)
	}
	return CherryPickPathsIn("", hash, paths)
}

// CherryPickPathsIn is CherryPickPaths but runs in the given worktree dir
func CherryPickPathsIn(dir, hash string, paths []string) error {
	if len(paths) == 0 {
		return fmt.Errorf("no paths to apply from %s", hash)
	}
	args := []string{"diff", "--binary", "--color=never", hash + "^.." + hash, "--"}
	args = append(args, paths...)
	patch, err := GitExec(args...)
	if err != nil {
		return fmt.Errorf("get patch: %w", err)
	}
	if strings.TrimSpace(patch) == "" {
		return fmt.Errorf("no changes in commit %s under requested paths", hash)
	}
	cmd := exec.Command("git", "apply", "--index", "--3way")
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Stdin = strings.NewReader(patch)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git apply: %v (stderr: %s)", err, stderr.String())
	}
	if _, err := GitExecIn(dir, "commit", "--no-verify", "-C", hash); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// GetFileDiffVsUpstream returns combined diff of file between upstream and HEAD.
func GetFileDiffVsUpstream(upstream, file string) (string, error) {
	out, err := GitExec("diff", "--color=never", upstream+"...HEAD", "--", ":/"+file)
	if err != nil {
		return "", err
	}
	return clampDiff(out), nil
}

// GetChangedFilesVsUpstream returns all files differing between HEAD and upstream.
func GetChangedFilesVsUpstream(upstream string) ([]string, error) {
	out, err := GitExec("diff", "--name-only", upstream+"...HEAD")
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// ApplyFileFullDiff generates cumulative diff (upstream..HEAD) of one file and
// applies it to working tree of dir without commit/stage.
func ApplyFileFullDiff(dir, upstream, file string) error {
	patch, err := GitExec("diff", "--binary", "--color=never", upstream+"...HEAD", "--", ":/"+file)
	if err != nil {
		return fmt.Errorf("get patch: %w", err)
	}
	if strings.TrimSpace(patch) == "" {
		return fmt.Errorf("no changes for %s vs %s", file, upstream)
	}
	cmd := exec.Command("git", "apply", "--3way")
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Stdin = strings.NewReader(patch)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git apply: %v (stderr: %s)", err, stderr.String())
	}
	return nil
}

// ApplyFilePatch generates patch for single file from commit and applies it
// to working tree of dir (no index update, no commit).
func ApplyFilePatch(dir, hash, file string) error {
	patch, err := GitExec("diff", "--binary", "--color=never", hash+"^.."+hash, "--", ":/"+file)
	if err != nil {
		return fmt.Errorf("get patch: %w", err)
	}
	if strings.TrimSpace(patch) == "" {
		return fmt.Errorf("empty patch for %s in %s", file, hash[:8])
	}
	cmd := exec.Command("git", "apply", "--3way")
	if dir != "" {
		cmd.Dir = dir
	}
	cmd.Stdin = strings.NewReader(patch)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("git apply: %v (stderr: %s)", err, stderr.String())
	}
	return nil
}

// AbortCherryPick aborts current cherry-pick
func AbortCherryPick() error {
	_, err := GitExec("cherry-pick", "--abort")
	return err
}

// ContinueCherryPick continues cherry-pick after resolving conflicts
func ContinueCherryPick() error {
	_, err := GitExec("cherry-pick", "--continue")
	return err
}

// HasCherryPickInProgress checks if there's a cherry-pick in progress
func HasCherryPickInProgress() bool {
	_, err := GitExec("rev-parse", "--verify", "CHERRY_PICK_HEAD")
	return err == nil
}

// GetCommitDiff returns the diff for a specific commit
func GetCommitDiff(hash string) (string, error) {
	out, err := GitExec("show", hash, "--stat", "-p", "--color=never")
	if err != nil {
		return "", err
	}
	return clampDiff(out), nil
}

// GetCommitDiffForFiles returns diff for commit limited to given files
func GetCommitDiffForFiles(hash string, files []string) (string, error) {
	if len(files) == 0 {
		return "", nil
	}
	args := []string{"show", hash, "--stat", "-p", "--color=never", "--"}
	for _, f := range files {
		args = append(args, ":/"+f)
	}
	out, err := GitExec(args...)
	if err != nil {
		return "", err
	}
	return clampDiff(out), nil
}

// GetCommitDiffInFolder returns diff for commit limited to paths under folder
func GetCommitDiffInFolder(hash, folder string) (string, error) {
	pathspec := folder
	if !strings.HasSuffix(pathspec, "/") {
		pathspec += "/"
	}
	out, err := GitExec("show", hash, "--stat", "-p", "--color=never", "--", ":/"+pathspec)
	if err != nil {
		return "", err
	}
	return clampDiff(out), nil
}

// clampDiff truncates very large diffs to keep TUI responsive.
const diffMaxBytes = 200_000

func clampDiff(s string) string {
	if len(s) <= diffMaxBytes {
		return s
	}
	return s[:diffMaxBytes] + "\n\n[... diff truncated, " +
		fmt.Sprintf("%d bytes total", len(s)) + "]\n"
}

// GetCommitFilesInFolder returns files changed in commit that live under folder
func GetCommitFilesInFolder(hash, folder string) ([]string, error) {
	files, err := GetCommitFiles(hash)
	if err != nil {
		return nil, err
	}
	if folder == "" {
		return files, nil
	}
	prefix := folder
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	var out []string
	for _, f := range files {
		if strings.HasPrefix(f, prefix) {
			out = append(out, f)
		}
	}
	return out, nil
}

// GetOutgoingCommits returns commits in HEAD not in upstream
func GetOutgoingCommits(upstreamBranch string) ([]Commit, error) {
	format := "%H|%h|%s|%an|%ad"
	out, err := GitExec("log", upstreamBranch+"..HEAD", "--format="+format, "--date=short")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return []Commit{}, nil
	}
	commits := make([]Commit, 0, len(lines))
	for _, line := range lines {
		parts := strings.SplitN(line, "|", 5)
		if len(parts) < 5 {
			continue
		}
		commits = append(commits, Commit{
			Hash:      parts[0],
			ShortHash: parts[1],
			Subject:   parts[2],
			Author:    parts[3],
			Date:      parts[4],
		})
	}
	return commits, nil
}

// GetCommitFiles returns list of files changed in commit
func GetCommitFiles(hash string) ([]string, error) {
	out, err := GitExec("show", "--name-only", "--format=", hash)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			files = append(files, line)
		}
	}
	return files, nil
}

// BranchExists checks if local branch exists
func BranchExists(name string) bool {
	_, err := GitExec("rev-parse", "--verify", "refs/heads/"+name)
	return err == nil
}

// CreateBranchFrom creates new branch from start point without checking out
func CreateBranchFrom(name, startPoint string) error {
	_, err := GitExec("branch", name, startPoint)
	return err
}

// CheckoutBranch switches to given branch
func CheckoutBranch(name string) error {
	_, err := GitExec("checkout", name)
	return err
}
