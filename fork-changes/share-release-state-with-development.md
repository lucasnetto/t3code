# Share release state with development

Root development commands now use the same `userdata` state directory as release builds instead
of selecting a separate `dev` directory when a Vite development URL is present. This keeps
projects, threads, settings, and the environment identity consistent while switching between a
source checkout and an installed release.

Desktop development continues to use its development branding and Electron profile, but its T3
Code state is read from the release `userdata` directory. Developers who need isolation can set a
different `T3CODE_HOME` or pass `--home-dir` to the root dev runner.

Because the state includes a SQLite database, a development process and release process must not
use the same T3 Code home concurrently.
