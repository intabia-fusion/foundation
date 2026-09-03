package main

import "testing"

func TestParseLogEntries(t *testing.T) {
	out := "\x1eaaa\x1faaa1\x1f2026-07-01\x1fDenis Bykhov\x1fCard fix (#1)\n\nplugins/card/index.ts\nmodels/card/index.ts\n" +
		"\x1ebbb\x1fbbb1\x1f2026-07-02\x1fAndrey Sobolev\x1fProcess fix (#2)\n\nplugins/process/index.ts\n"
	got := parseLogEntries(out)
	if len(got) != 2 {
		t.Fatalf("want 2 entries, got %d", len(got))
	}
	if got[0].Hash != "aaa" || got[0].Author != "Denis Bykhov" || got[0].Subject != "Card fix (#1)" {
		t.Errorf("bad head parse: %+v", got[0])
	}
	if len(got[0].Files) != 2 || got[0].Files[1] != "models/card/index.ts" {
		t.Errorf("bad files parse: %+v", got[0].Files)
	}
	if len(got[1].Files) != 1 {
		t.Errorf("bad second entry files: %+v", got[1].Files)
	}
}

func TestPkgOf(t *testing.T) {
	for in, want := range map[string]string{
		"plugins/card/src/index.ts": "plugins/card",
		"models/process/index.ts":   "models/process",
		"package.json":              "package.json",
	} {
		if got := pkgOf(in); got != want {
			t.Errorf("pkgOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGroupPaths(t *testing.T) {
	if p, err := groupPaths("all"); err != nil || p != nil {
		t.Errorf("all should mean no pathspec, got %v %v", p, err)
	}
	p, err := groupPaths("card,process")
	if err != nil || len(p) != len(pathGroups["card"])+len(pathGroups["process"]) {
		t.Errorf("card,process = %v, err %v", p, err)
	}
	if _, err := groupPaths("nope"); err == nil {
		t.Error("unknown group should error")
	}
}
