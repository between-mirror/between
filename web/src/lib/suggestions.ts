// Between Mirror — optional pre-answered questions for the Ask surface.
//
// Empty in the installed application, and it stays empty: nothing in the product registers anything
// here. It exists so the browser demo can offer a few questions it has real answers for, without
// putting demo logic inside a shared view — the demo's separation from the product is the thing that
// guarantees the installed app cannot serve frozen answers, and it should not be spent on this.
//
// When the list is empty the Ask box behaves exactly as it always has: type anything, and the planner
// answers or honestly declines. When it is populated, the view offers the questions instead of a text
// box, because the demo can only answer those and a text box that silently accepts anything else
// would be a trap.
let suggestions: readonly string[] = [];

/** Called once, before render, by the demo entry point only. */
export function setAskSuggestions(list: readonly string[]): void {
  suggestions = [...list];
}

export function askSuggestions(): readonly string[] {
  return suggestions;
}
