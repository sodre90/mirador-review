/** The hover hints of the review's view, in Mirador's words. */
export const hints = {
  answerCannotResolve: "GitHub does not let you resolve this conversation.",
  answerDecision:
    "Kept answers go to their conversations on the pull request when you post, as replies on your pending review; dropped ones stay here. Click to switch.",
  answerResolve:
    "Resolve this conversation on GitHub when its answer is posted. The answer waits on your pending review until you submit it, but the conversation shows as resolved to everyone at once.",
  askAndUpdateReview:
    "Ask, and tell the agent to update the parts of the review its answer changes, such as a finding, the tour, the summary or the verdict. They change in place, and the rest stays as you left it.",
  fileInTour: "The flow tour passes through this file; such files come first.",
  findMatchCase: "Match case: capital and small letters count as different.",
  findingChecked:
    "Confirmed: the agent verified it (ran, traced or tested the code). Plausible: suspected, not verified.",
  findingDecision:
    "Kept findings go to the pull request when you post; dropped ones stay here. Click to switch.",
  findingNumber:
    "The number the agent knows this finding by: when it writes finding 5 or finding-5, it means #5.",
  findingOutsideDiff:
    "GitHub takes line comments only on changed lines and the 3 lines around them, so this one cannot be posted as a comment. It stays in the review.",
  revealAll:
    "Shows every line of the file between the two changes (or up to the file's start or end).",
  revealOverNext: "Shows the lines of the file right above the change below.",
  revealUnderPrevious:
    "Shows the next lines of the file, under the change above.",
  reviewFileMatches: "How often this file holds the text you are finding",
  reviewFind:
    "Find text in the code of every changed file, in the lines their diffs show.",
  reviewFindNext: "Next match, further down and on into the next file (Enter)",
  reviewFindPrevious: "Previous match, further up (Shift+Enter)",
  reviewLineNumber:
    "Click to select this line, Shift+click to select up to it. Then a asks the agent about the lines, o opens them in IntelliJ IDEA.",
  reviewPlacement:
    "Show the review over the whole workspace, or in the canvas pane next to the chat. The code review plugin's setting in Settings picks where reviews open.",
  splitter: "Drag to resize, double-click to reset.",
  terminalFindRegex:
    "Use regular expression: the text is a JavaScript regular expression, such as error|warn.",
  terminalFindWholeWord:
    "Match whole word: only where the text stands on its own, not inside a longer word.",
  tourPlacement:
    "Show the tour over the whole workspace, or in the canvas pane next to the chat.",
};
