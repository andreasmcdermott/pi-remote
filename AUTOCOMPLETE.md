# File Reference Autocomplete

The web UI supports file reference autocomplete in the message input.
Type `@` and then part of a file/path to search project files.

## User behavior

1. Type `@` in the message box
2. Keep typing a filename or path fragment
3. Pick a suggestion via:
   - arrow keys + Enter/Tab
   - mouse/tap
4. The selected value is inserted into the message, followed by a space

Examples:

- `@read` → `README.md`
- `@src/cli` → `src/cli.ts`
- `@package` → `package.json`

## Matching behavior

Ranking is filename-first and fuzzy-friendly:

- exact/prefix matches score highest
- basename matches are prioritized over full-path matches
- slash-containing queries (`@src/...`) increase full-path relevance
- case-sensitive matches are rewarded when query includes uppercase

## Bridge implementation (`bridge.ts`)

Autocomplete uses a bridge-side file scan endpoint:

- command: `list_files`
- response: `response` with `command: "list_files"` and `data.files`

Bridge file list details:

- recursive directory walk from `AGENT_CWD`
- short cache TTL (`FILE_LIST_CACHE_TTL = 5000` ms)
- ignores common heavy/build dirs (`node_modules`, `.git`, `dist`, etc.)
- includes directories with trailing `/` for path completion
- excludes dotfiles from suggestions

## Client implementation (`public/client.js`)

- detects active `@query` near cursor
- requests files once (then reuses cache)
- computes relevance score client-side
- renders top 15 suggestions
- supports keyboard/mouse navigation and dismissal

## Styling (`public/style.css`)

Autocomplete popup:

- element: `#file-autocomplete`
- item class: `.file-autocomplete-item`
- selected item class: `.focused`

The popup is positioned above the input and optimized for touch devices.

## Tuning knobs

- cache TTL: `FILE_LIST_CACHE_TTL` in `bridge.ts`
- ignored directories/files: `IGNORED_DIRS`, `IGNORED_FILES` in `bridge.ts`
- max suggestions: `.slice(0, 15)` in `updateAutocompleteSuggestions()`

## Debugging

Browser console:

```js
fileList
autocompleteState
sendWithId({ type: "list_files", forceRefresh: true })
```

If suggestions are missing:

- verify bridge is running in expected `AGENT_CWD`
- check ignored directory rules
- confirm files are not dotfiles
