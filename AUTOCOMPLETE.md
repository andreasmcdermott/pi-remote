# File Reference Autocomplete

The web UI now supports file reference autocomplete just like the TUI — type `@` in the message input to fuzzy-search and autocomplete project files.

## Features

- **Fuzzy matching**: Type `@src/t` to match `src/temp.ts`, `src/temp/*.*`, `src/utils/temp.ts`, etc.
- **Keyboard navigation**: Use ↑↓ arrow keys to navigate suggestions, Enter or Tab to select, Escape to cancel
- **Cached file list**: Files are cached for 5 seconds to avoid excessive filesystem scans
- **Smart ignore list**: Automatically excludes `node_modules`, `.git`, `dist`, `build`, and other common directories
- **Mobile-friendly**: Popup appears above the input on all screen sizes

## How to use

1. Type `@` anywhere in your message
2. Start typing the filename or path you want to reference (e.g., `README`, `src/main`, `package.json`)
3. The autocomplete popup will show matching files with fuzzy scoring
4. Select with ↑↓ arrow keys or mouse, then press Enter/Tab or click to insert
5. The file reference will be inserted as `@filename.ext`

## Examples

| Typed | Matches |
|-------|---------|
| `@read` | `README.md`, `src/reader.ts`, etc. |
| `@src/t` | `src/temp.ts`, `src/temp/file.txt`, `src/test.ts`, etc. |
| `@pkg` | `package.json`, `package-lock.json` |
| `@.env` | `.env`, `.env.example`, `.env.local` |

## Implementation Details

### Bridge Side (bridge.ts)

- `getFileList()` - Recursively scans the working directory (CWD) for files, excluding common ignored directories
- `listFilesRecursive()` - DFS traversal with built-in ignore patterns
- File list cache with 5-second TTL to balance freshness vs. performance
- `list_files` RPC handler - Responds to client requests with the current file list

### Client Side (public/client.js)

- Input listener detects `@` characters and extracts the query string
- `fuzzyScore()` - Sublime Text-style fuzzy scoring algorithm with:
  - Consecutive character bonus
  - Word boundary bonus (matches after `/`)
  - Position bonus (prefers early matches)
- `renderAutocomplete()` - Renders suggestions popup above the input
- Keyboard navigation: Arrow keys for selection, Enter/Tab to select, Escape to cancel
- Auto-dismisses when user types whitespace or invalid characters

### Styling (public/style.css)

- `#file-autocomplete` - Popup container (fixed positioning, max 200px height)
- `.file-autocomplete-item` - Individual suggestion item
- `.file-autocomplete-item.focused` - Keyboard/hover highlight
- Integrated with existing dark theme using CSS variables

## Performance

- **Lazy loading**: File list is only fetched on first `@` keypress
- **Smart caching**: 5-second cache prevents excessive filesystem scans
- **Limited results**: Only top 15 matches shown (computed in real-time)
- **Efficient fuzzy**: Scores computed on client side (browser) after file list loaded

## Ignored Directories

The bridge automatically excludes these directories from the file list:

- `node_modules`, `.git`, `.next`, `dist`, `build`
- `.venv`, `__pycache__`, `.vscode`, `.idea`
- `.DS_Store`, `target`, `coverage`, `out`, `.turbo`

Add more to the `IGNORED_DIRS` Set in bridge.ts if needed.

## Customization

### Adjust cache TTL

Edit `bridge.ts`:

```typescript
const FILE_LIST_CACHE_TTL = 5000; // milliseconds
```

### Adjust max suggestions shown

Edit `client.js`:

```javascript
autocompleteState.suggestions = scored
  .filter(item => item.score > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 15) // Change 15 to desired count
  .map(item => item.file);
```

### Adjust ignored directories

Edit `bridge.ts`:

```typescript
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  // Add more here
]);
```
