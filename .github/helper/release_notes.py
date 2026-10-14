"""Build release notes from the conventional commits between the previous tag and TAG.

Usage: python release_notes.py <tag> <owner/repo>
"""

import re
import subprocess
import sys

SECTIONS = [
	("breaking", "⚠️ Breaking Changes"),
	("feat", "🚀 Features"),
	("fix", "🐛 Bug Fixes"),
	("perf", "⚡ Performance"),
	("revert", "⏪ Reverts"),
	("other", "Other Changes"),
]
SKIP = {"chore", "ci", "docs", "style", "test", "build", "refactor"}
COMMIT_RE = re.compile(r"^(?P<type>\w+)(?:\((?P<scope>[^)]*)\))?(?P<bang>!)?:\s*(?P<desc>.+)$")


def git(*args):
	return subprocess.check_output(["git", *args], text=True).strip()


def main(tag, repo):
	try:
		prev = git("describe", "--tags", "--abbrev=0", f"{tag}^")
		rev_range = f"{prev}..{tag}"
	except subprocess.CalledProcessError:
		prev, rev_range = None, tag

	log = git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1f%an%x1e", rev_range)
	groups = {key: [] for key, _ in SECTIONS}

	for entry in filter(None, (e.strip() for e in log.split("\x1e"))):
		sha, subject, body, author = entry.split("\x1f")
		m = COMMIT_RE.match(subject)
		if m and m["type"].lower() in SKIP:
			continue

		if m:
			kind = m["type"].lower()
			text = f"**{m['scope']}:** {m['desc']}" if m["scope"] else m["desc"]
		else:
			kind, text = "other", subject

		if (m and m["bang"]) or "BREAKING CHANGE" in body:
			kind = "breaking"
		elif kind not in groups:
			kind = "other"

		groups[kind].append(f"* {text} ({sha[:7]}) by {author}")

	lines = ["## What's Changed", ""]
	for key, title in SECTIONS:
		if groups[key]:
			lines += [f"### {title}", "", *groups[key], ""]

	if not any(groups.values()):
		lines += ["No user-facing changes.", ""]

	if prev:
		lines.append(f"**Full Changelog**: https://github.com/{repo}/compare/{prev}...{tag}")

	print("\n".join(lines))


if __name__ == "__main__":
	main(sys.argv[1], sys.argv[2])
