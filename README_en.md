# List Outline

The plugin provides independently switchable floating heading outline, persistent right-side heading dock, and floating list outline. The heading outline follows the current document and uses SiYuan's native `/api/outline/getDocOutline` tree, heading levels, and numbering.

- **Right-side Heading Outline Dock**: Enable "Right-side Heading Outline Dock" in plugin settings to register a persistent dock in SiYuan's right sidebar. It supports search, selectable list depth, click navigation, right-click sibling insertion, and automatic highlighting and scrolling based on the block under the editor pointer.
- **Floating Heading Outline**: Displays the outline on the right side of the editor, auto-collapsing to minimalist lines and expanding on hover.
- **Sibling Insertion**: Right-click a heading or list entry to insert a sibling above or below it. A heading inserted below follows the entire current section, matching SiYuan's native outline behavior.
- **List Depth**: Use the heading panel/dock or plugin settings dropdown to hide lists or include 1–20 levels beneath their headings in document order. The option defaults to hidden and is saved automatically. Per-list depth still takes priority, blockquotes are excluded, and the setting remains independent of the floating list panel.

A SiYuan plugin that displays compact outline lines at the upper-right corner of a hovered list. Hover over the lines to expand the labels and depth settings; move away to collapse them.

- Supports ordered, unordered, task, and nested lists.
- Outlines remain visible while lists stay in the viewport, and hide automatically when scrolled out of view.
- Search and filter list items in real time with keyword highlighting; press Escape to clear search, and search resets automatically when collapsed.
- Option to hide the list outline if the list has no child blocks (nested sub-lists, blockquotes, code blocks, extra paragraphs, etc.) (`listOutlineRequireChildren`).
- Lists inside blockquotes are excluded from the outline and do not trigger a separate panel.
- Defaults to 3 levels. Labels fit one line and overflow with an ellipsis; hover for the full text.
- Configure global depth (1–20) in plugin settings. The character limit setting has been removed; older character limits are ignored.
- Choose a depth in the floating panel to override the current list, or restore the global default.
- Click an entry to navigate to its list item.
- The outermost list and its nested lists share one outline. Only list items add levels; additional paragraphs and block metadata do not.
- Requires a mouse or another pointer with hover support; no dedicated touch-only entry point is provided.

Global settings are saved in `settings.json`. Per-list depth is saved as the list block attribute `custom-list-outline-depth`. Restoring the default clears this attribute without rewriting list content.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

`pnpm build` generates `dist/` and `package.zip`, then automatically copies `dist/` to the SiYuan workspace at `data/plugins/siyuan-plugin-list-outline/`. Enable the plugin after the first sync. The package can also be installed in another workspace.

`pnpm dev` watches changes and copies `dev/` after every build. Both modes wait for static assets to finish writing. Set `SIYUAN_PLUGIN_DIR` to override the plugins directory in `scripts/make_dev_copy.js`. Sync failures are reported separately; retry with `pnpm make_dev_copy dist` or `pnpm make_dev_copy dev`.

DOM tests do not replace interaction checks inside the SiYuan client.

Based on [plugin-sample-vite-svelte](https://github.com/siyuan-note/plugin-sample-vite-svelte/).


## ❤️ Tips Are Welcome

If you find this plugin useful, you're welcome to leave a tip or give the repository a star on GitHub. Your support helps me maintain and improve this plugin and develop new ones. Thank you for your support!

[Leave a tip](https://pancake.waffo.ai/store/achuan-2-fdbho4ye/product/PROD_3F7Aa7c2NQlz9KmxcgxjQ7?type=onetime&currency=USD)