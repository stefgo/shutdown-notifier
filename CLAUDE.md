# shutdown-notifier — CLAUDE.md

How the project is built, tested and released is described in [README.md](README.md).
This file holds what has to be kept to when changing it.

## Releases

A release is started by hand with the *Create Release* workflow, on `main` for a release and
on `dev` for a beta. Its notes open with the text written by hand in `.release/next.md`,
followed by the list of commits; a release without that text is refused. **Never bump a
version or create a `v*` tag by hand.**

### The release notes are part of the commit

Before every commit, read `.release/next.md` and bring it up to date with what the commit
changes — in the same commit, not at release time.

- A commit that changes what a user sees or has to do — a feature, a fix, a changed
  default, a renamed setting, anything an upgrade needs — is reflected in the text. A
  `feat`, `fix` or `perf` commit that leaves the file untouched needs a reason.
- A commit that changes nothing for a user (`ci`, `test`, `refactor`, `docs`, `chore`,
  most of `build`) leaves the file alone. No line is added for the sake of it.
- Revise the text as a whole instead of appending a line per commit: it describes the
  release, not its history. Merge what belongs together, and remove a sentence a later
  commit made untrue — a feature taken back before the release is not in its notes.
- Write for someone who uses the project, in their terms: what is new, why it matters,
  what an upgrade needs. No file names and no internals; the list of commits below the
  text already names every change.
- The text goes below the HTML comment at the top of the file, with `###` headings. If
  the file holds only the comment, the text starts with this commit.
