/** Simple tab switcher: click a tab button, show its panel, hide the rest. */
export class TabBar {
  #tabs;

  constructor(tabs) {
    this.#tabs = tabs;
    for (const tab of tabs) tab.button.addEventListener("click", () => this.select(tab));
  }

  select(target) {
    for (const tab of this.#tabs) {
      const active = tab === target;
      tab.button.setAttribute("aria-selected", String(active));
      tab.panel.hidden = !active;
    }
  }
}
