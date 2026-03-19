# File Autocomplete — Quick Reference

## For users

### Type

```text
@file        -> search by filename fragment
@src/main    -> search by path fragment
@README      -> match README variants
```

### Keys

| Key | Action |
|---|---|
| ↑ / ↓ | move selection |
| Enter / Tab | insert selected file |
| Escape | close popup |

## For developers

### Main touchpoints

- `bridge.ts`
  - `listFilesRecursive()`
  - `getFileList()`
  - `handleClientMessage()` → `list_files`
- `public/client.js`
  - `autocompleteState`
  - `fuzzyScore()` / `fileMatchScore()`
  - `updateAutocompleteSuggestions()`
  - `renderAutocomplete()`
- `public/style.css`
  - `#file-autocomplete`
  - `.file-autocomplete-item`
  - `.file-autocomplete-item.focused`
- `public/index.html`
  - `<div id="file-autocomplete"></div>`

### RPC shape

Client → bridge:

```json
{ "type": "list_files", "id": "client-123", "forceRefresh": false }
```

Bridge → client:

```json
{
  "type": "response",
  "command": "list_files",
  "success": true,
  "id": "client-123",
  "data": { "files": ["README.md", "src/main.ts"] }
}
```

### Common adjustments

- Cache TTL: `FILE_LIST_CACHE_TTL` in `bridge.ts`
- Ignore lists: `IGNORED_DIRS` / `IGNORED_FILES` in `bridge.ts`
- Max suggestions: `.slice(0, 15)` in `updateAutocompleteSuggestions()`

### Debug helpers

```js
fileList
autocompleteState
sendWithId({ type: "list_files", forceRefresh: true })
```
