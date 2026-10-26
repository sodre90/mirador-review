# Code review for Mirador

A [Mirador](https://github.com/sodre90/mirador) canvas plugin: code reviews and guided tours of the code flow, drawn on the canvas.

- `review` publishes a review of `base...head` in a checkout, like a pull request: a summary, a tour of the code flow, the diff from git and findings on its lines. The user keeps or drops each finding, rewords it, asks the agent about any lines, and posts the kept ones to the GitHub pull request as a pending review, with answers to its existing conversations.
- `update_review` changes parts of a review in place: findings, answers, the tour, the summary or the verdict.
- `tour` walks the user through code without reviewing it, or through what a task changed when given a git ref to count from.
- Lines open in IntelliJ IDEA through its `idea` launcher; posting uses the GitHub CLI, `gh`.
- *Open reviews* in Settings → Plugins → Code review sets whether reviews open full screen or beside the chat.

Mirador installs it by itself at its first start, and it can be removed in Settings → Plugins like any plugin. To install it by hand, add `https://github.com/sodre90/mirador-review.git` there.

## Developing

```bash
bun install
bun run build       # the view, into dist/view.js
bun run typecheck
bun run test        # unit tests, with Mirador's host code from the checkout in MIRADOR_DIR
scripts/e2e.sh      # e2e in a Mirador test host from MIRADOR_DIR, with Mirador's Playwright
```

`MIRADOR_DIR` is Mirador's checkout, by default `../visualized-claude-sessions`. `mirador/api.ts` is a copy of the plugin API types Mirador doesn't publish yet. `shared/review.ts` is a copy of Mirador's: Mirador keeps it as the format of reviews and tours, which its phone app draws natively, so a change to it starts in Mirador.

Releases: bump `version` in `plugin.json`, commit, and tag the commit `v<version>`. Mirador installs the newest release and offers newer ones as updates.
