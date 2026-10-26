export type ShortcutCommand =
  | { type: "palette" }
  | { type: "help" }
  | { type: "adjacent-conversation"; step: 1 | -1 }
  | { type: "adjacent-workspace"; step: 1 | -1 }
  | { type: "numbered-conversation"; number: number }
  | { type: "new-conversation" }
  | { type: "new-workspace" }
  | { type: "toggle-canvas" }
  | { type: "toggle-terminal" }
  | { type: "find" }
  | { type: "search" }
  | { type: "mark-unread" }
  | { type: "focus"; pane: "chat" | "canvas" | "terminals" }
  | { type: "bigger-font" }
  | { type: "smaller-font" }
  | { type: "reset-font" }
  | { type: "reload-page" }
  | { type: "restart-host" };

export interface KeyPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Where the keyboard focus is: text-editing keys must keep working while the user types, and on macOS a terminal keeps ⌘K to clear itself. */
export type TypingState = "not-typing" | "empty-field" | "typing" | "terminal";

export const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

/** ⌘ on macOS, Ctrl elsewhere, without the other one. */
const holdsPrimary = (press: KeyPress, mac: boolean) => (mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey);

/**
 * Bindings chosen so that neither Chrome nor cmux (when the app runs in a cmux browser pane)
 * takes them first. Option+letter bindings avoid macOS dead keys (Option+E/I/N/U/`).
 */
export function commandFor(press: KeyPress, typing: TypingState, mac = isMac): ShortcutCommand | null {
  const primary = holdsPrimary(press, mac);
  const optionOnly = press.altKey && !press.metaKey && !press.ctrlKey;

  const terminalClears = mac && typing === "terminal";
  const terminalSearchesHistory = !mac && typing === "terminal";
  const terminalFinds = !mac && typing === "terminal";
  const terminalEntersUnicode = !mac && typing === "terminal";
  if (primary && !press.altKey && !press.shiftKey && press.code === "KeyK" && !terminalClears) return { type: "palette" };
  if (primary && !press.altKey && press.code === "KeyR" && !terminalSearchesHistory) return press.shiftKey ? { type: "restart-host" } : { type: "reload-page" };
  if (primary && !press.altKey && !press.shiftKey && press.code === "Backslash") return { type: "toggle-canvas" };
  if (press.ctrlKey && !press.metaKey && !press.altKey && !press.shiftKey && press.code === "Backquote") return { type: "toggle-terminal" };
  if (primary && !press.altKey && !press.shiftKey && press.code === "KeyF" && typing !== "terminal") return { type: "find" };
  if (primary && !press.altKey && press.shiftKey && press.code === "KeyF" && !terminalFinds) return { type: "search" };
  if (primary && !press.altKey && press.shiftKey && press.code === "KeyU" && !terminalEntersUnicode) return { type: "mark-unread" };
  if (primary && !press.altKey && press.shiftKey && typing !== "typing") {
    if (press.code === "ArrowLeft") return { type: "focus", pane: "chat" };
    if (press.code === "ArrowRight") return { type: "focus", pane: "canvas" };
    if (press.code === "ArrowDown") return { type: "focus", pane: "terminals" };
  }
  if (optionOnly) {
    const step = press.code === "ArrowDown" ? 1 : press.code === "ArrowUp" ? -1 : null;
    if (step) return press.shiftKey ? { type: "adjacent-workspace", step } : { type: "adjacent-conversation", step };
    const digit = press.code.match(/^Digit([1-9])$/)?.[1];
    if (digit && !press.shiftKey) return { type: "numbered-conversation", number: Number(digit) };
    if (press.code === "KeyT") return press.shiftKey ? { type: "new-workspace" } : { type: "new-conversation" };
  }
  if (press.key === "?" && !press.metaKey && !press.ctrlKey && !press.altKey && typing === "not-typing") return { type: "help" };
  if (primary && !press.altKey) {
    if (press.code === "Equal" || press.code === "NumpadAdd") return { type: "bigger-font" };
    if ((press.code === "Minus" || press.code === "NumpadSubtract") && !press.shiftKey) return { type: "smaller-font" };
    if ((press.code === "Digit0" || press.code === "Numpad0") && !press.shiftKey) return { type: "reset-font" };
  }
  return null;
}

/** In the message box: find a prompt template to put in at the caret. */
export const findsTemplate = (press: KeyPress, mac = isMac) => holdsPrimary(press, mac) && !press.altKey && !press.shiftKey && press.code === "KeyJ";

/** Anywhere in the window, the canvas included: dictate into the message box. */
export const dictates = (press: KeyPress, mac = isMac) => holdsPrimary(press, mac) && press.shiftKey && !press.altKey && press.code === "Space";

export function typingStateOf(element: Element | null): TypingState {
  if (element?.closest(".xterm")) return "terminal";
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type !== "checkbox")) {
    return element.value === "" ? "empty-field" : "typing";
  }
  if (element instanceof HTMLElement && element.isContentEditable) return "typing";
  return "not-typing";
}

export const keyLabels = (mac = isMac) => ({
  primary: mac ? "⌘" : "Ctrl+",
  option: mac ? "⌥" : "Alt+",
  shift: mac ? "⇧" : "Shift+",
});

/** The keys of commands that a button does too; the button's hint shows them. */
export function shortcutKeys(mac = isMac) {
  const { primary, option, shift } = keyLabels(mac);
  return {
    palette: `${primary}K`,
    help: "?",
    newConversation: `${option}T`,
    newWorkspace: `${option}${shift}T`,
    toggleCanvas: `${primary}\\`,
    toggleTerminal: mac ? "⌃`" : "Ctrl+`",
    focusTerminal: `${primary}${shift}↓`,
    find: `${primary}F`,
    search: `${primary}${shift}F`,
    restartHost: `${primary}${shift}R`,
    markUnread: `${primary}${shift}U`,
    templates: `${primary}J`,
    dictate: `${primary}${shift}Space`,
    send: "Enter",
    sendTheOtherWay: `${option}Enter`,
    stop: "Esc",
  };
}

/** The keys cmux and iTerm2 share, which a focused terminal takes on macOS; Linux terminals have no such convention. */
export const terminalShortcutKeys = (mac = isMac) => (mac ? { splitRight: "⌘D", splitDown: "⌘⇧D", newTab: "⌘T", close: "⌘W", zoom: "⌘⇧↩" } : null);

const terminalHelp = (keys: NonNullable<ReturnType<typeof terminalShortcutKeys>>) => [
  { keys: `${keys.splitRight} / ${keys.splitDown}`, action: "In a terminal: split it, the new shell right of it / below it" },
  { keys: "⌥⌘← ⌥⌘→ ⌥⌘↑ ⌥⌘↓ · ⌘[ / ⌘]", action: "In a terminal: go to the split that way · the previous / next split" },
  { keys: "⌘⇧[ / ⌘⇧] · ⌘1 … ⌘9, ⌃1 … ⌃9", action: "In a terminal: previous / next terminal tab · terminal tab by number" },
  { keys: `${keys.newTab} / ${keys.close}`, action: "In a terminal: new terminal tab / close this terminal; one running a command asks first" },
  { keys: keys.zoom, action: "In a terminal: let it fill its tab, and back" },
];

export function shortcutHelp(mac = isMac): { keys: string; action: string }[] {
  const { primary, option, shift } = keyLabels(mac);
  const keys = shortcutKeys(mac);
  return [
    { keys: keys.palette, action: "Palette: go to a conversation, start one, open a dialog (in a terminal, clears it instead)" },
    { keys: `${option}↑ / ${option}↓`, action: "Previous / next conversation" },
    { keys: `${option}${shift}↑ / ${option}${shift}↓`, action: "Previous / next workspace" },
    { keys: `${option}1 … ${option}9`, action: "Conversation 1–9 in this workspace" },
    { keys: keys.newConversation, action: "New conversation in this workspace (with its profile)" },
    { keys: keys.newWorkspace, action: "Add a workspace (a project directory)" },
    { keys: keys.toggleCanvas, action: "Show / hide the canvas" },
    { keys: keys.toggleTerminal, action: "Show / hide the terminal" },
    { keys: keys.search, action: "Search every conversation in every workspace" },
    { keys: keys.markUnread, action: "Mark this conversation unread and go back to the one open before it (right-click a conversation in the sidebar to mark any)" },
    { keys: keys.find, action: "Find in this conversation, earlier entries and folded cards included; Aa matches case (Enter: older match, Shift+Enter: newer)" },
    { keys: keys.find, action: "In a review or tour: find in the code of its changed files, with match case, whole word and regular expression toggles (Enter: next match, Shift+Enter: previous)" },
    { keys: mac ? keys.find : "Ctrl+Shift+F", action: "In a terminal: find in its output, with match case, whole word and regular expression toggles (Enter: match further up, Shift+Enter: further down)" },
    { keys: `${primary}V`, action: "In the message box, an image on the clipboard goes in as [Image #1] (dropping an image file does too)" },
    { keys: keys.templates, action: "In the message box: find a prompt template by typing and put it in; Tab / Shift+Tab then go through its {{values}}" },
    { keys: keys.dictate, action: "Dictate into the message box: tap to start, and it stops when you pause or tap again; or hold while you talk. Esc cancels (Settings → Voice turns it on)" },
    { keys: `${primary}${shift}← / ${primary}${shift}→ / ${primary}${shift}↓`, action: "Focus the message box / the canvas / the terminal (not while editing text)" },
    { keys: `${primary}+ / ${primary}−`, action: "Make text bigger / smaller (in a terminal, changes its font size instead)" },
    { keys: `${primary}0`, action: "Reset text size to 100% (in a terminal, resets to 12 px)" },
    { keys: `${primary}R`, action: "Reload the page, with the UI code as it is now" },
    { keys: keys.restartHost, action: "Restart the host to run its code as it is now; working agents stop and then continue where they left off" },
    { keys: `${keys.send} / ${keys.sendTheOtherWay}`, action: "While the agent works: add the message to its running turn, or send it after the turn ends (Settings picks which key does which)" },
    { keys: "Esc", action: "Close a dialog; in the message box, stop the running turn" },
    { keys: keys.help, action: "This list (outside text fields)" },
    ...(mac ? terminalHelp(terminalShortcutKeys(mac)!) : []),
  ];
}
